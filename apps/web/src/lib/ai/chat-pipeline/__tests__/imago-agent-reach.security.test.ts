// @vitest-environment node
/**
 * IMG-4.9 — a built-in Imago agent never reads beyond its grants (security).
 *
 * Driven through the REAL page-chat turn (`POST /api/ai/chat`) against a real
 * Postgres, on the IMG-4.7/4.8 harness. Real: the session, the database, Imago
 * provisioning, the per-drive Imago access toggle (IMG-4.6), the page shares
 * and memberships, the AI SDK's own tool loop and every tool executor. Replaced:
 * only the language model, by the SDK's `MockLanguageModelV3`, scripted to call
 * tools the way a model would. What the suite asserts on is the tool output
 * the AI SDK feeds back to the model — exactly what the model could read.
 *
 * The world, from the user's point of view:
 *   - Home: their own Home drive, where the Imago agents live.
 *   - Acme: a drive they own; the agents are granted it (DEC-2 default).
 *   - Journal: a drive they own, with Imago access switched off (IMG-4.6).
 *   - Partner: another user's drive; the user is ADMIN and switched Imago on.
 *   - Rival: another user's drive they have nothing to do with.
 *   - Former: another user's drive the user was removed from, keeping one page
 *     share. The agents' grant there outlived the membership (see seedWorld).
 *   - Gone: the same, without the page share: the user cannot see it at all.
 *   - Other Home: another user's Home drive; the user holds page shares on a
 *     few of its pages, so they can see those, but the agent must not.
 *
 * Every seeded title and body carries a run-unique marker, so "the marker of a
 * page X appears in any tool output" is a precise leak test.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import type { MockLanguageModelV3 } from 'ai/test';

type CallOptions = Parameters<MockLanguageModelV3['doStream']>[0];

interface ScriptedCall {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnCapture {
  toolNames: string[];
  outputs: Map<string, unknown>;
}

/** The tool calls the mock model makes on its first step of the next turn. */
let script: ScriptedCall[] = [];
let capture: TurnCapture = { toolNames: [], outputs: new Map() };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/core/provider-factory')>();
  const { MockLanguageModelV3: Mock } = await import('ai/test');
  return {
    ...actual,
    createAIProvider: vi.fn(async () => ({
      model: new Mock({
        doStream: async (options: CallOptions) => {
          const results = options.prompt.flatMap((message) =>
            message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [],
          );
          // First step: call the scripted tools. Second step: record what they returned and stop.
          const firstStep = results.length === 0;
          if (firstStep) capture.toolNames = (options.tools ?? []).map((tool) => tool.name);
          for (const result of results) capture.outputs.set(result.toolCallId, result.output);

          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                if (firstStep && script.length > 0) {
                  script.forEach((call, index) => {
                    controller.enqueue({
                      type: 'tool-call',
                      toolCallId: `call-${index}`,
                      toolName: call.toolName,
                      input: JSON.stringify(call.input),
                    });
                  });
                  controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage });
                } else {
                  controller.enqueue({ type: 'text-start', id: 't1' });
                  controller.enqueue({ type: 'text-delta', id: 't1', delta: 'done' });
                  controller.enqueue({ type: 'text-end', id: 't1' });
                  controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
                }
                controller.close();
              },
            }),
          };
        },
      }),
      provider: 'ollama',
      modelName: 'mock-model',
    })),
    updateUserProviderSettings: vi.fn(async () => undefined),
  };
});

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { BUILTIN_AGENTS, type BuiltinAgentKey } from '@pagespace/lib/agents/builtin-agents';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { POST } from '@/app/api/ai/chat/route';

const MARK = `img49${createId().slice(0, 10)}`;
const seededUserIds: string[] = [];

/** A seeded page: its id and the marker its title and body carry. */
interface Seeded {
  id: string;
  marker: string;
}

interface World {
  userId: string;
  token: string;
  agents: Record<BuiltinAgentKey, string>;
  home: { driveId: string; note: Seeded };
  acme: { driveId: string; roadmap: Seeded; minutes: Seeded };
  journal: { driveId: string; entry: Seeded };
  partner: { driveId: string; open: Seeded; restricted: Seeded };
  rival: { driveId: string; open: Seeded; restricted: Seeded };
  former: { driveId: string; shared: Seeded; unshared: Seeded; restricted: Seeded };
  gone: { driveId: string; open: Seeded; agent: Seeded };
  otherHome: {
    driveId: string;
    shared: Seeded;
    unshared: Seeded;
    sheet: Seeded;
    agent: Seeded;
    conversationId: string;
    taskList: Seeded;
    task: Seeded;
    taskId: string;
  };
}

let world: World;

async function seedPage(
  driveId: string,
  label: string,
  overrides: Partial<typeof pages.$inferInsert> = {},
): Promise<Seeded> {
  const marker = `${MARK}-${label}`;
  const page = await factories.createPage(driveId, {
    title: `${marker} title`,
    content: `line one\nsecret body ${marker}\nline three`,
    ...overrides,
  });
  return { id: page.id, marker };
}

async function seedWorld(): Promise<World> {
  const user = await factories.createUser();
  const other = await factories.createUser();
  const stranger = await factories.createUser();
  seededUserIds.push(user.id, other.id, stranger.id);

  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });
  const acme = await factories.createDrive(user.id, { name: `${MARK} Acme`, slug: `acme-${createId()}` });
  const journal = await factories.createDrive(user.id, { name: `${MARK} Journal`, slug: `journal-${createId()}` });
  const partner = await factories.createDrive(other.id, { name: `${MARK} Partner`, slug: `partner-${createId()}` });
  const rival = await factories.createDrive(stranger.id, { name: `${MARK} Rival`, slug: `rival-${createId()}` });
  const former = await factories.createDrive(other.id, { name: `${MARK} Former`, slug: `former-${createId()}` });
  const gone = await factories.createDrive(other.id, { name: `${MARK} Gone`, slug: `gone-${createId()}` });
  const otherHome = await factories.createDrive(other.id, { kind: 'HOME', name: `${MARK} OtherHome`, slug: `other-home-${createId()}` });

  await factories.createDriveMember(partner.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });
  await factories.createDriveMember(former.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });
  await factories.createDriveMember(gone.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });

  // Owned STANDARD drives (Acme, Journal) are granted here, as at sign-in.
  const { agents } = await provisionImagoAgents(user.id);

  // The IMG-4.6 toggle, through its real service: Journal off, Partner and Former on.
  expect((await setImagoDriveAccess(user.id, journal.id, false)).ok).toBe(true);
  expect((await setImagoDriveAccess(user.id, partner.id, true)).ok).toBe(true);
  expect((await setImagoDriveAccess(user.id, former.id, true)).ok).toBe(true);
  expect((await setImagoDriveAccess(user.id, gone.id, true)).ok).toBe(true);

  // Former: the user then loses the membership, but the agents' grants stay.
  // That is what a drive-member rollback, a redo of a member removal and a
  // permissions restore do (rollbackMemberChange, redoMemberChange,
  // restore-permissions-service): they delete the `drive_members` row and
  // never call revokeAgentMembershipsGrantedBy. The user keeps one page share.
  await db.delete(driveMembers).where(and(inArray(driveMembers.driveId, [former.id, gone.id]), eq(driveMembers.userId, user.id)));

  const formerShared = await seedPage(former.id, 'former-shared');
  await factories.createPagePermission(formerShared.id, user.id);

  const otherShared = await seedPage(otherHome.id, 'otherhome-shared');
  const otherSheet = await seedPage(otherHome.id, 'otherhome-sheet', { type: 'SHEET' });
  const otherAgent = await seedPage(otherHome.id, 'otherhome-agent', { type: 'AI_CHAT', content: '' });
  const message = await factories.createChatMessage(otherAgent.id, { userId: other.id, content: `${MARK}-otherhome-chat` });
  const otherTaskList = await seedPage(otherHome.id, 'otherhome-tasklist', { type: 'TASK_LIST', content: '' });
  const otherTask = await seedPage(otherHome.id, 'otherhome-task', { parentId: otherTaskList.id });
  await db.insert(taskLists).values({ userId: other.id, pageId: otherTaskList.id, title: `${MARK}-otherhome-list` });
  const [task] = await db
    .insert(taskItems)
    .values({ userId: other.id, pageId: otherTask.id, status: 'pending', assigneeAgentId: otherAgent.id })
    .returning({ id: taskItems.id });
  // The user can see — and edit — these pages of the other user's Home; the agent must not.
  for (const page of [otherShared, otherSheet, otherAgent, otherTaskList, otherTask]) {
    await factories.createPagePermission(page.id, user.id, { canEdit: true });
  }

  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    userId: user.id,
    token,
    agents,
    home: { driveId: home.id, note: await seedPage(home.id, 'home-note') },
    acme: {
      driveId: acme.id,
      roadmap: await seedPage(acme.id, 'acme-roadmap'),
      minutes: await seedPage(acme.id, 'acme-minutes', { isPrivate: true }),
    },
    journal: { driveId: journal.id, entry: await seedPage(journal.id, 'journal-entry') },
    partner: {
      driveId: partner.id,
      open: await seedPage(partner.id, 'partner-open'),
      restricted: await seedPage(partner.id, 'partner-restricted', { isPrivate: true }),
    },
    rival: {
      driveId: rival.id,
      open: await seedPage(rival.id, 'rival-open'),
      restricted: await seedPage(rival.id, 'rival-restricted', { isPrivate: true }),
    },
    former: {
      driveId: former.id,
      shared: formerShared,
      unshared: await seedPage(former.id, 'former-unshared'),
      restricted: await seedPage(former.id, 'former-restricted', { isPrivate: true }),
    },
    gone: {
      driveId: gone.id,
      open: await seedPage(gone.id, 'gone-open'),
      agent: await seedPage(gone.id, 'gone-agent', { type: 'AI_CHAT', content: '' }),
    },
    otherHome: {
      driveId: otherHome.id,
      shared: otherShared,
      unshared: await seedPage(otherHome.id, 'otherhome-unshared'),
      sheet: otherSheet,
      agent: otherAgent,
      conversationId: message.conversationId,
      taskList: otherTaskList,
      task: otherTask,
      taskId: task.id,
    },
  };
}

/** Run one real turn in which the agent calls `calls`; returns each call's output, serialized. */
async function runTools(
  agentPageId: string,
  calls: ScriptedCall[],
  contextRef?: ContextRef,
): Promise<{ toolNames: string[]; outputs: string[] }> {
  script = calls;
  capture = { toolNames: [], outputs: new Map() };
  const response = await POST(
    new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${world.token}`,
        'x-browser-session-id': 'browser-img-4-9',
      },
      body: JSON.stringify({
        messages: [{ id: createId(), role: 'user', parts: [{ type: 'text', text: 'Look around.' }] }],
        chatId: agentPageId,
        conversationId: createId(),
        selectedProvider: 'openai',
        selectedModel: 'openai/gpt-5.4-nano',
        ...(contextRef ? { contextRef } : {}),
      }),
    }),
  );
  expect(response.status, await response.clone().text().catch(() => '')).toBe(200);
  await response.text();
  await vi.waitFor(() => expect(capture.outputs.size).toBe(calls.length), { timeout: 15_000 });
  return {
    toolNames: capture.toolNames,
    outputs: calls.map((_, index) => JSON.stringify(capture.outputs.get(`call-${index}`))),
  };
}

/**
 * The markers of `pagesToHide` that appear anywhere in `outputs`. Markers, not
 * ids: a refusal may echo the id the model asked for, never the page's title
 * or body.
 */
function leaked(outputs: string[], pagesToHide: Seeded[]): string[] {
  const all = outputs.join('\n');
  return pagesToHide.filter((page) => all.includes(page.marker)).map((page) => page.marker);
}

/** Every tool path that reads a drive, aimed at `driveId` (and `pageId` in it). */
const readPathsInto = (driveId: string, pageId: string): ScriptedCall[] => [
  { toolName: 'read_page', input: { title: 'page', pageId } },
  { toolName: 'list_pages', input: { driveId, recursive: true } },
  { toolName: 'regex_search', input: { driveId, pattern: MARK, searchIn: 'both' } },
  { toolName: 'glob_search', input: { driveId, pattern: '**' } },
];

// Each test runs one or more real turns (route, tool loop, every executor);
// the first one in a worker also pays the cold import of the whole route.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await ensureTestDb();
  world = await seedWorld();
}, 60_000);

afterAll(async () => {
  if (seededUserIds.length > 0) {
    await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
});

describe('Imago agent reach — positive controls (the harness reads what it is granted)', () => {
  it('given a granted drive, should read, list and search its pages', async () => {
    const { outputs } = await runTools(world.agents.imago, readPathsInto(world.acme.driveId, world.acme.roadmap.id));

    for (const output of outputs) expect(output).toContain(world.acme.roadmap.marker);
  });

  it('given cross-drive search, should find pages in the Home drive and every granted drive', async () => {
    const { outputs } = await runTools(world.agents.imago, [
      { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
    ]);

    expect(outputs[0]).toContain(world.home.note.marker);
    expect(outputs[0]).toContain(world.acme.roadmap.marker);
    expect(outputs[0]).toContain(world.partner.open.marker);
  });
});

describe('IMG-4.9 AC1 — a drive without a grant: no page reads, search hits or tree listing', () => {
  it('given an owned drive with Imago access switched off, should deny every read path', async () => {
    const { outputs } = await runTools(world.agents.imago, readPathsInto(world.journal.driveId, world.journal.entry.id));

    expect(leaked(outputs, [world.journal.entry])).toEqual([]);
  });

  it("given another user's drive the user cannot see, should deny every read path", async () => {
    const { outputs } = await runTools(world.agents.imago, [
      ...readPathsInto(world.rival.driveId, world.rival.open.id),
      { toolName: 'read_page', input: { title: 'page', pageId: world.rival.restricted.id } },
    ]);

    expect(leaked(outputs, [world.rival.open, world.rival.restricted])).toEqual([]);
  });

  it('given the ungranted drive in view, should deny the read paths that default to it', async () => {
    const { outputs } = await runTools(
      world.agents.imago,
      [
        { toolName: 'read_page', input: { title: 'current page' } },
        { toolName: 'list_pages', input: { recursive: true } },
        { toolName: 'regex_search', input: { pattern: MARK, searchIn: 'both' } },
        { toolName: 'glob_search', input: { pattern: '**' } },
      ],
      { routeType: 'page', pageId: world.journal.entry.id, driveId: world.journal.driveId },
    );

    expect(leaked(outputs, [world.journal.entry])).toEqual([]);
  });

  it('given cross-drive search and list_drives, should leave the ungranted drives out', async () => {
    const { outputs } = await runTools(world.agents.imago, [
      { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
      { toolName: 'list_drives', input: {} },
    ]);

    expect(leaked(outputs, [world.journal.entry, world.rival.open, world.rival.restricted])).toEqual([]);
    for (const name of [`${MARK} Journal`, `${MARK} Rival`]) expect(outputs.join('\n')).not.toContain(name);
  });

  it('given a drive whose membership the user lost while the grant survived, should read only what the user can still view', async () => {
    const { outputs } = await runTools(world.agents.imago, [
      ...readPathsInto(world.former.driveId, world.former.unshared.id),
      { toolName: 'read_page', input: { title: 'page', pageId: world.former.restricted.id } },
      { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
    ]);

    expect(leaked(outputs, [world.former.unshared, world.former.restricted])).toEqual([]);
  });

  it('given a drive the user can no longer see at all while the grant survived, should not even name it', async () => {
    const { outputs } = await runTools(world.agents.imago, [
      ...readPathsInto(world.gone.driveId, world.gone.open.id),
      { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
      { toolName: 'list_drives', input: {} },
      { toolName: 'list_agents', input: { driveId: world.gone.driveId } },
      { toolName: 'multi_drive_list_agents', input: {} },
    ]);

    expect(leaked(outputs, [world.gone.open, world.gone.agent])).toEqual([]);
    expect(outputs.join('\n')).not.toContain(`${MARK} Gone`);
  });

  it('given each Imago agent (planner, researcher), should deny the same read paths', async () => {
    for (const key of ['imago-planner', 'imago-researcher'] as const) {
      const { outputs } = await runTools(world.agents[key], [
        ...readPathsInto(world.journal.driveId, world.journal.entry.id),
        { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
      ]);

      expect(leaked(outputs, [world.journal.entry, world.rival.open, world.former.unshared, world.gone.open]), key).toEqual([]);
    }
  });
});

describe("IMG-4.9 AC2 — another user's Home drive: every tool path denied", () => {
  /** One call per tool any Imago agent holds, each aimed at the other user's Home. */
  const otherHomeCalls = (): Record<string, ScriptedCall['input']> => {
    const { driveId, shared, sheet, agent, conversationId, taskList, taskId } = world.otherHome;
    return {
      list_drives: {},
      list_pages: { driveId, recursive: true },
      read_page: { title: 'page', pageId: shared.id },
      read_sheet: { pageId: sheet.id },
      glob_search: { driveId, pattern: '**' },
      regex_search: { driveId, pattern: MARK, searchIn: 'both' },
      multi_drive_search: { searchQuery: MARK },
      create_page: { driveId, title: `${MARK}-created`, type: 'DOCUMENT' },
      rename_page: { currentTitle: 'page', pageId: shared.id, title: `${MARK}-renamed` },
      replace_lines: { title: 'page', pageId: shared.id, startLine: 1, content: `${MARK}-replaced` },
      insert_content: { title: 'page', pageId: shared.id, anchor: 'line one', content: `${MARK}-inserted`, position: 'after' },
      move_page: { title: 'page', pageId: shared.id, targetDriveId: world.home.driveId, position: 1 },
      get_assigned_tasks: { agentId: agent.id, driveId },
      create_task: { pageId: taskList.id, title: `${MARK}-new-task` },
      update_task: { taskId, title: `${MARK}-task-renamed` },
      reorder_task: { taskId, position: 0 },
      get_activity: { driveIds: [driveId] },
      list_agents: { driveId },
      multi_drive_list_agents: {},
      list_conversations: { pageId: agent.id, title: 'agent' },
      read_conversation: { pageId: agent.id, conversationId, title: 'agent' },
    };
  };

  /** Every page and task row in the other user's Home, for a before/after comparison. */
  const otherHomeState = async () => ({
    pages: await db
      .select({ id: pages.id, title: pages.title, content: pages.content, parentId: pages.parentId, position: pages.position })
      .from(pages)
      .where(eq(pages.driveId, world.otherHome.driveId))
      .orderBy(pages.id),
    tasks: await db
      .select({ id: taskItems.id, pageId: taskItems.pageId, status: taskItems.status, metadata: taskItems.metadata })
      .from(taskItems)
      .innerJoin(pages, eq(pages.id, taskItems.pageId))
      .where(eq(pages.driveId, world.otherHome.driveId))
      .orderBy(taskItems.id),
    moved: await db.select({ id: pages.id }).from(pages).where(and(eq(pages.id, world.otherHome.shared.id), eq(pages.driveId, world.otherHome.driveId))),
  });

  const otherHomePages = () => {
    const { shared, unshared, sheet, agent, taskList, task } = world.otherHome;
    return [shared, unshared, sheet, agent, taskList, task];
  };

  it('given the page shares, should let the USER see those pages (so the agent is the one being refused)', async () => {
    expect((await getUserAccessLevel(world.userId, world.otherHome.shared.id))?.canEdit).toBe(true);
  });

  it('given the scripted calls, should cover every tool any Imago agent is given', () => {
    const allTools = new Set(BUILTIN_AGENTS.flatMap((agent) => agent.enabledTools));

    expect(Object.keys(otherHomeCalls()).sort()).toEqual([...allTools].sort());
  });

  it.each(BUILTIN_AGENTS.map((agent) => agent.key))(
    'given the %s agent, should neither read nor change anything in it',
    async (key) => {
      const calls = Object.entries(otherHomeCalls())
        .filter(([toolName]) => BUILTIN_AGENTS.find((agent) => agent.key === key)!.enabledTools.includes(toolName))
        .map(([toolName, input]) => ({ toolName, input }));

      const before = await otherHomeState();
      const { toolNames, outputs } = await runTools(world.agents[key], calls, {
        routeType: 'page',
        pageId: world.otherHome.shared.id,
        driveId: world.otherHome.driveId,
      });

      // Every scripted tool really was offered to the model and really ran.
      for (const call of calls) expect(toolNames, call.toolName).toContain(call.toolName);
      expect(leaked(outputs, otherHomePages())).toEqual([]);
      expect(outputs.join('\n')).not.toContain(`${MARK} OtherHome`);
      expect(outputs.join('\n')).not.toContain(`${MARK}-otherhome-chat`);

      // Nothing changed: no page created, renamed, edited or moved; no task created, renamed or moved.
      expect(await otherHomeState()).toEqual(before);
    },
  );

  it('given the read paths that default to the page in view, should deny them too', async () => {
    const { outputs } = await runTools(
      world.agents.imago,
      [
        { toolName: 'read_page', input: { title: 'current page' } },
        { toolName: 'list_pages', input: { recursive: true } },
        { toolName: 'regex_search', input: { pattern: MARK, searchIn: 'both' } },
        { toolName: 'glob_search', input: { pattern: '**' } },
      ],
      { routeType: 'page', pageId: world.otherHome.shared.id, driveId: world.otherHome.driveId },
    );

    expect(leaked(outputs, otherHomePages())).toEqual([]);
  });
});

describe('IMG-4.9 AC3 — cross-drive search never returns titles the user cannot view', () => {
  it('given every Imago agent, should return no page the user cannot view, in any drive', async () => {
    for (const key of BUILTIN_AGENTS.map((agent) => agent.key)) {
      const { outputs } = await runTools(world.agents[key], [
        { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
        { toolName: 'multi_drive_search', input: { searchQuery: `${MARK}.*title`, searchType: 'regex' } },
      ]);

      const hits = outputs.join('\n');
      const notViewable = [
        world.journal.entry,
        world.rival.open,
        world.rival.restricted,
        world.former.unshared,
        world.former.restricted,
        world.gone.open,
        ...[world.otherHome.shared, world.otherHome.unshared, world.otherHome.sheet],
      ];
      // The user CAN view these through shares, but the agent holds no grant on Other Home.
      expect(leaked([hits], notViewable), key).toEqual([]);
      // Ground truth: every page the search did return is one the user can view.
      for (const pageId of new Set([...hits.matchAll(/"pageId":"([a-z0-9]+)"/g)].map((match) => match[1]))) {
        expect((await getUserAccessLevel(world.userId, pageId))?.canView, `${key} returned ${pageId}`).toBe(true);
      }
    }
  });

  it('given private pages in a granted drive, should not return them to a MEMBER-granted agent', async () => {
    const { outputs } = await runTools(world.agents.imago, [
      { toolName: 'multi_drive_search', input: { searchQuery: MARK } },
    ]);

    // Partner: the user (ADMIN) can view the private page, the MEMBER-capped agent cannot.
    expect(leaked(outputs, [world.partner.restricted])).toEqual([]);
    expect(outputs[0]).toContain(world.partner.open.marker);
  });
});
