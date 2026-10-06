// @vitest-environment node
/**
 * IMG-4.9, rewritten for IMG-10.10 — Imago's reach is its owner's, minus the
 * drives the owner keeps it out of, never more than the owner, and nothing at
 * all for anyone else (security).
 *
 * Driven through the REAL page-chat turn (`POST /api/ai/chat`) against a real
 * Postgres. Real: the sessions, the database, Imago provisioning, the per-drive
 * Imago setting through its real service, the page shares and memberships, the
 * AI SDK's own tool loop and every tool executor — including `execute_tool`,
 * behind which Imago's non-core tools sit exactly as the global assistant's do.
 * Replaced: only the language model, by the SDK's `MockLanguageModelV3`,
 * scripted to call tools the way a model would. What the suite asserts on is
 * the tool output the AI SDK feeds back to the model, and the prompt it was
 * sent — exactly what the model could read.
 *
 * The world, from the owner's point of view:
 *   - Home: their Home drive, where Imago lives.
 *   - Acme: a drive they own, with a private page.
 *   - Journal: a drive they own and keep Imago out of (with a drive prompt).
 *   - Partner: another user's drive they administer, with a private page.
 *   - Team: another user's drive they are a MEMBER of: an open page, a private
 *     page shared with them, a private page not shared with them.
 *   - Locked: another user's drive they are a MEMBER of and keep Imago out of.
 *   - Rival: another user's drive they have nothing to do with.
 *   - Other Home: another user's Home drive, where they hold one page share.
 * And a visitor who can open the owner's Imago page through a page share.
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
  prompt: string;
  outputs: Map<string, unknown>;
}

/** The tool calls the mock model makes on its first step of the next turn. */
let script: ScriptedCall[] = [];
let capture: TurnCapture = { toolNames: [], prompt: '', outputs: new Map() };

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
          if (firstStep) {
            capture.toolNames = (options.tools ?? []).map((tool) => tool.name);
            capture.prompt = JSON.stringify(options.prompt);
          }
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
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { logActivity } from '@pagespace/lib/monitoring/activity-logger';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { CORE_TOOL_NAMES } from '@/lib/ai/core/stub-tools';
import { ensureTestDb } from '@/test/ensure-test-db';
import type { ContextRef } from '@/lib/ai/shared/buildContextRef';
import { POST } from '@/app/api/ai/chat/route';

const MARK = `img1010${createId().slice(0, 10)}`;
const seededUserIds: string[] = [];

/** A seeded page: its id and the marker its title and body carry. */
interface Seeded {
  id: string;
  marker: string;
}

interface World {
  ownerId: string;
  ownerToken: string;
  visitorToken: string;
  imagoPageId: string;
  home: { driveId: string; note: Seeded };
  acme: { driveId: string; roadmap: Seeded; minutes: Seeded };
  journal: { driveId: string; entry: Seeded; sheet: Seeded };
  partner: { driveId: string; open: Seeded; restricted: Seeded };
  team: { driveId: string; open: Seeded; sharedPrivate: Seeded; unsharedPrivate: Seeded };
  locked: { driveId: string; entry: Seeded };
  rival: { driveId: string; open: Seeded };
  otherHome: { driveId: string; shared: Seeded; unshared: Seeded };
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
  const owner = await factories.createUser();
  const other = await factories.createUser();
  const stranger = await factories.createUser();
  const visitor = await factories.createUser();
  seededUserIds.push(owner.id, other.id, stranger.id, visitor.id);

  const home = await factories.createDrive(owner.id, { kind: 'HOME', name: 'Home', slug: `home-${createId()}` });
  const acme = await factories.createDrive(owner.id, { name: `${MARK} Acme`, slug: `acme-${createId()}` });
  const journal = await factories.createDrive(owner.id, {
    name: `${MARK} Journal`,
    slug: `journal-${createId()}`,
    drivePrompt: `${MARK}-journal-prompt`,
  });
  const partner = await factories.createDrive(other.id, { name: `${MARK} Partner`, slug: `partner-${createId()}` });
  const team = await factories.createDrive(other.id, { name: `${MARK} Team`, slug: `team-${createId()}` });
  const locked = await factories.createDrive(other.id, { name: `${MARK} Locked`, slug: `locked-${createId()}` });
  const rival = await factories.createDrive(stranger.id, { name: `${MARK} Rival`, slug: `rival-${createId()}` });
  const otherHome = await factories.createDrive(other.id, { kind: 'HOME', name: `${MARK} OtherHome`, slug: `other-home-${createId()}` });

  await factories.createDriveMember(partner.id, owner.id, { role: 'ADMIN', acceptedAt: new Date() });
  await factories.createDriveMember(team.id, owner.id, { role: 'MEMBER', acceptedAt: new Date() });
  await factories.createDriveMember(locked.id, owner.id, { role: 'MEMBER', acceptedAt: new Date() });

  const { agents } = await provisionImagoAgents(owner.id);

  // The per-drive setting, through its real service: kept out of an owned
  // drive and of a drive the owner is merely a member of.
  expect((await setImagoDriveAccess(owner.id, journal.id, false)).ok).toBe(true);
  expect((await setImagoDriveAccess(owner.id, locked.id, false)).ok).toBe(true);

  const teamShared = await seedPage(team.id, 'team-private-shared', { isPrivate: true });
  await factories.createPagePermission(teamShared.id, owner.id);
  const otherShared = await seedPage(otherHome.id, 'otherhome-shared');
  await factories.createPagePermission(otherShared.id, owner.id, { canEdit: true });

  // The visitor can open the owner's Imago page, and nothing else of theirs.
  await factories.createPagePermission(agents.imago, visitor.id, { canEdit: true });

  // Drive-level activity (no pageId): Acme is the control; the excluded drives must not surface.
  for (const drive of [acme, journal, locked]) {
    await logActivity({
      userId: owner.id,
      actorEmail: 'someone@example.com',
      operation: 'update',
      resourceType: 'drive',
      resourceId: drive.id,
      resourceTitle: drive.name,
      driveId: drive.id,
    });
  }

  const session = (userId: string) =>
    sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  return {
    ownerId: owner.id,
    ownerToken: await session(owner.id),
    visitorToken: await session(visitor.id),
    imagoPageId: agents.imago,
    home: { driveId: home.id, note: await seedPage(home.id, 'home-note') },
    acme: {
      driveId: acme.id,
      roadmap: await seedPage(acme.id, 'acme-roadmap'),
      minutes: await seedPage(acme.id, 'acme-minutes', { isPrivate: true }),
    },
    journal: {
      driveId: journal.id,
      entry: await seedPage(journal.id, 'journal-entry'),
      sheet: await seedPage(journal.id, 'journal-sheet', { type: 'SHEET' }),
    },
    partner: {
      driveId: partner.id,
      open: await seedPage(partner.id, 'partner-open'),
      restricted: await seedPage(partner.id, 'partner-restricted', { isPrivate: true }),
    },
    team: {
      driveId: team.id,
      open: await seedPage(team.id, 'team-open'),
      sharedPrivate: teamShared,
      unsharedPrivate: await seedPage(team.id, 'team-private-unshared', { isPrivate: true }),
    },
    locked: { driveId: locked.id, entry: await seedPage(locked.id, 'locked-entry') },
    rival: { driveId: rival.id, open: await seedPage(rival.id, 'rival-open') },
    otherHome: {
      driveId: otherHome.id,
      shared: otherShared,
      unshared: await seedPage(otherHome.id, 'otherhome-unshared'),
    },
  };
}

/**
 * A tool call as the model makes it on Imago's surface, which is the global
 * assistant's: core tools directly, every other one through `execute_tool`.
 */
const call = (toolName: string, input: Record<string, unknown>): ScriptedCall =>
  CORE_TOOL_NAMES.has(toolName)
    ? { toolName, input }
    : { toolName: 'execute_tool', input: { tool_name: toolName, parameters: input } };

/** Run one real turn in which Imago calls `calls`; returns each call's output, serialized. */
async function runTools(
  calls: ScriptedCall[],
  contextRef?: ContextRef,
  token = world.ownerToken,
): Promise<{ toolNames: string[]; prompt: string; outputs: string[] }> {
  script = calls;
  capture = { toolNames: [], prompt: '', outputs: new Map() };
  const response = await POST(
    new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-browser-session-id': 'browser-img-10-10',
      },
      body: JSON.stringify({
        messages: [{ id: createId(), role: 'user', parts: [{ type: 'text', text: 'Look around.' }] }],
        chatId: world.imagoPageId,
        conversationId: createId(),
        selectedProvider: 'openai',
        selectedModel: 'openai/gpt-5.4-nano',
        ...(contextRef ? { contextRef } : {}),
      }),
    }),
  );
  expect(response.status, await response.clone().text().catch(() => '')).toBe(200);
  await response.text();
  await vi.waitFor(() => expect(capture.toolNames.length).toBeGreaterThan(0), { timeout: 15_000 });
  await vi.waitFor(() => expect(capture.outputs.size).toBe(calls.length), { timeout: 15_000 });
  return {
    toolNames: capture.toolNames,
    prompt: capture.prompt,
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
  call('read_page', { title: 'page', pageId }),
  call('list_pages', { driveId, recursive: true }),
  call('regex_search', { driveId, pattern: MARK, searchIn: 'both' }),
  call('glob_search', { driveId, pattern: '**' }),
];

/** Every page and drive name in the excluded drives, for before/after comparisons. */
const excludedState = async () =>
  db
    .select({ id: pages.id, title: pages.title, content: pages.content, parentId: pages.parentId, isTrashed: pages.isTrashed })
    .from(pages)
    .where(inArray(pages.driveId, [world.journal.driveId, world.locked.driveId]))
    .orderBy(pages.id);

/** The ids of every page `outputs` names, for the "never more than the user" ground truth. */
const pageIdsIn = (outputs: string[]) =>
  [...new Set([...outputs.join('\n').matchAll(/"(?:pageId|id)":"([a-z0-9]{20,})"/g)].map((match) => match[1]))];

// Each test runs one or more real turns (route, tool loop, every executor);
// the first one in a worker also pays the cold import of the whole route.
vi.setConfig({ testTimeout: 45_000 });

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

describe("IMG-10.10 — Imago acts with its owner's full reach", () => {
  it('given owned, administered and member-only drives, should read, list and search them — private pages the user can see included', async () => {
    for (const [driveId, page] of [
      [world.acme.driveId, world.acme.minutes],
      [world.partner.driveId, world.partner.restricted],
      [world.team.driveId, world.team.open],
    ] as const) {
      const { outputs } = await runTools(readPathsInto(driveId, page.id));
      for (const output of outputs) expect(output, page.marker).toContain(page.marker);
    }
  });

  it('given a private page shared with the user, and a page shared from another Home, should read them', async () => {
    const { outputs } = await runTools([
      call('read_page', { title: 'page', pageId: world.team.sharedPrivate.id }),
      call('read_page', { title: 'page', pageId: world.otherHome.shared.id }),
    ]);

    expect(outputs[0]).toContain(world.team.sharedPrivate.marker);
    expect(outputs[1]).toContain(world.otherHome.shared.marker);
  });

  it('given cross-drive search, should find pages across every drive the user reaches', async () => {
    const { outputs } = await runTools([call('multi_drive_search', { searchQuery: MARK })]);

    for (const page of [world.home.note, world.acme.roadmap, world.acme.minutes, world.partner.restricted, world.team.open, world.team.sharedPrivate]) {
      expect(outputs[0], page.marker).toContain(page.marker);
    }
  });

  it('given a write, should create a page in a drive the user administers but does not own', async () => {
    const { outputs } = await runTools([
      call('create_page', { driveId: world.partner.driveId, title: `${MARK}-created-by-imago`, type: 'DOCUMENT' }),
    ]);

    const created = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.driveId, world.partner.driveId), eq(pages.title, `${MARK}-created-by-imago`)));
    expect(created, outputs[0]).toHaveLength(1);
  });
});

describe('IMG-10.10 — never more than its owner', () => {
  it("given pages the user cannot view (another user's drive, an unshared private page, an unshared page of another Home), should deny every read path", async () => {
    const { outputs } = await runTools([
      ...readPathsInto(world.rival.driveId, world.rival.open.id),
      call('read_page', { title: 'page', pageId: world.team.unsharedPrivate.id }),
      call('read_page', { title: 'page', pageId: world.otherHome.unshared.id }),
      call('list_pages', { driveId: world.otherHome.driveId, recursive: true }),
    ]);

    expect(leaked(outputs, [world.rival.open, world.team.unsharedPrivate, world.otherHome.unshared])).toEqual([]);
  });

  it('given cross-drive search, should return only pages the user can view', async () => {
    const { outputs } = await runTools([
      call('multi_drive_search', { searchQuery: MARK }),
      call('multi_drive_search', { searchQuery: `${MARK}.*title`, searchType: 'regex' }),
    ]);

    expect(leaked(outputs, [world.rival.open, world.team.unsharedPrivate, world.otherHome.unshared])).toEqual([]);
    // Ground truth: every page the search returned is one the user can view.
    for (const pageId of pageIdsIn(outputs)) {
      expect((await getUserAccessLevel(world.ownerId, pageId))?.canView, pageId).toBe(true);
    }
  });
});

describe('IMG-10.10 — a drive the owner keeps Imago out of is denied on every path', () => {
  const excludedPages = () => [world.journal.entry, world.journal.sheet, world.locked.entry];
  const excludedNames = () => [`${MARK} Journal`, `${MARK} Locked`, `${MARK}-journal-prompt`];

  it('given read paths into an excluded drive (owned, or one the user is a member of), should deny them', async () => {
    const { outputs } = await runTools([
      ...readPathsInto(world.journal.driveId, world.journal.entry.id),
      call('read_sheet', { pageId: world.journal.sheet.id }),
      ...readPathsInto(world.locked.driveId, world.locked.entry.id),
    ]);

    expect(leaked(outputs, excludedPages())).toEqual([]);
  });

  it('given cross-drive search, drive discovery, agents and activity, should neither return nor name an excluded drive', async () => {
    const { outputs } = await runTools([
      call('multi_drive_search', { searchQuery: MARK }),
      call('list_drives', {}),
      call('list_agents', { driveId: world.journal.driveId }),
      call('multi_drive_list_agents', {}),
      call('get_activity', { since: '30d', excludeOwnActivity: false }),
      call('get_activity', { since: '30d', excludeOwnActivity: false, driveIds: [world.journal.driveId, world.locked.driveId] }),
    ]);

    // Control: a drive Imago may use does come through discovery and activity.
    expect(outputs[1]).toContain(`${MARK} Acme`);
    expect(outputs[4]).toContain(`${MARK} Acme`);
    expect(leaked(outputs, excludedPages())).toEqual([]);
    const all = outputs.join('\n');
    for (const name of excludedNames()) expect(all, name).not.toContain(name);
  });

  it('given an excluded drive in view, should deny the read paths that default to it and keep its tree and prompt out of the context', async () => {
    const { outputs, prompt } = await runTools(
      [
        call('read_page', { title: 'current page' }),
        call('list_pages', { recursive: true }),
        call('regex_search', { pattern: MARK, searchIn: 'both' }),
        call('glob_search', { pattern: '**' }),
      ],
      { routeType: 'page', pageId: world.journal.entry.id, driveId: world.journal.driveId },
    );

    expect(leaked(outputs, excludedPages())).toEqual([]);
    expect(leaked([prompt], excludedPages())).toEqual([]);
    expect(prompt).not.toContain(`${MARK}-journal-prompt`);
    expect(prompt).toContain('a workspace they keep you out of');
  });

  it('given write paths into an excluded drive, should change nothing', async () => {
    const before = await excludedState();

    const { outputs } = await runTools([
      call('create_page', { driveId: world.journal.driveId, title: `${MARK}-created`, type: 'DOCUMENT' }),
      call('replace_lines', { title: 'page', pageId: world.journal.entry.id, startLine: 1, content: `${MARK}-replaced` }),
      call('insert_content', { title: 'page', pageId: world.locked.entry.id, anchor: 'line one', content: `${MARK}-inserted`, position: 'after' }),
      call('rename_page', { currentTitle: 'page', pageId: world.journal.entry.id, title: `${MARK}-renamed` }),
      call('move_page', { title: 'page', pageId: world.journal.entry.id, targetDriveId: world.acme.driveId, position: 1 }),
    ]);

    expect(leaked(outputs, excludedPages())).toEqual([]);
    // Refused for permission — not failing for some other reason after being allowed.
    for (const output of outputs) expect(output).toMatch(/permission|not found/i);
    expect(await excludedState()).toEqual(before);
    const created = await db.select({ id: pages.id }).from(pages).where(and(eq(pages.driveId, world.journal.driveId), eq(pages.title, `${MARK}-created`)));
    expect(created).toEqual([]);
  });

  it('negative control: given the same drive let back in, should read it, name it and show its activity — so the denials above are the exclusion', async () => {
    expect((await setImagoDriveAccess(world.ownerId, world.journal.driveId, true)).ok).toBe(true);
    try {
      const { outputs, prompt } = await runTools(
        [
          ...readPathsInto(world.journal.driveId, world.journal.entry.id),
          call('multi_drive_search', { searchQuery: MARK }),
          call('list_drives', {}),
          call('get_activity', { since: '30d', excludeOwnActivity: false, driveIds: [world.journal.driveId] }),
        ],
        { routeType: 'page', pageId: world.journal.entry.id, driveId: world.journal.driveId },
      );

      for (const output of outputs.slice(0, 5)) expect(output).toContain(world.journal.entry.marker);
      expect(outputs[5]).toContain(`${MARK} Journal`);
      expect(outputs[6]).toContain(`${MARK} Journal`);
      expect(prompt).toContain(`${MARK}-journal-prompt`);
      expect(prompt).not.toContain('a workspace they keep you out of');
    } finally {
      expect((await setImagoDriveAccess(world.ownerId, world.journal.driveId, false)).ok).toBe(true);
    }
  });
});

describe('IMG-10.10 — run by anyone but its owner, Imago gets nothing', () => {
  it('given a visitor who can open the Imago page, should offer no tool beyond finish and ask_user', async () => {
    const { toolNames, prompt } = await runTools([], undefined, world.visitorToken);

    expect(toolNames.filter((name) => name !== 'finish' && name !== 'ask_user')).toEqual([]);
    // None of the owner's drives or pages reaches the visitor's prompt.
    expect(prompt).not.toContain(`${MARK} Acme`);
    expect(leaked([prompt], [world.home.note, world.acme.roadmap, world.team.open])).toEqual([]);
  });

  it('negative control: given the owner, should offer the full assistant tool set', async () => {
    const { toolNames } = await runTools([]);

    expect(toolNames).toEqual(expect.arrayContaining(['read_page', 'multi_drive_search', 'tool_search', 'execute_tool']));
  });
});
