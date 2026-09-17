/**
 * Every route that AUTHORS a deferred agent run persists the writing
 * credential's ceiling on the workflow row (Sign in with PageSpace, Phase 2b).
 * `executeWorkflow` re-applies what is stored (workflow-credential-ceiling
 * integration test); this proves each write path stores it — every route and
 * every agent tool that authors a workflow or a task/calendar trigger — for a
 * drive-scoped `mcp_` key and for an OAuth grant with the same drive and role.
 *
 * Real: the route handlers, the auth door (token rows), Postgres. Stubbed: the
 * realtime broadcasts, the audit sink, rate limiting and Google Calendar push.
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { mcpTokenDrives } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { workflows } from '@pagespace/db/schema/workflows';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn((task: () => unknown) => { void Promise.resolve().then(task).catch(() => undefined); }),
}));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventToGoogle: vi.fn(async () => undefined),
  pushEventUpdateToGoogle: vi.fn(async () => undefined),
  pushEventDeleteToGoogle: vi.fn(async () => undefined),
}));
vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastPageEvent: vi.fn(async () => undefined),
  broadcastDriveEvent: vi.fn(async () => undefined),
  broadcastTaskEvent: vi.fn(async () => undefined),
  broadcastCalendarEvent: vi.fn(async () => undefined),
}));
vi.mock('@/lib/websocket/socket-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket/socket-utils')>()),
  broadcastDriveEvent: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'version', contentRef: 'snapshot', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));

import { POST as workflowsPOST } from '../workflows/route';
import { PATCH as workflowPATCH } from '../workflows/[workflowId]/route';
import { POST as tasksPOST } from '../pages/[pageId]/tasks/route';
import { PATCH as taskPATCH } from '../pages/[pageId]/tasks/[taskId]/route';
import { PUT as taskTriggerPUT } from '../tasks/[taskId]/triggers/route';
import { POST as eventsPOST } from '../calendar/events/route';
import { PATCH as eventPATCH } from '../calendar/events/[eventId]/route';
import { PUT as eventTriggerPUT } from '../calendar/events/[eventId]/triggers/route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { toolCredentialScope } from '@/lib/ai/core/tool-credential-scope';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { createTaskTriggerWorkflow } from '@/lib/workflows/task-trigger-helpers';
import { upsertCalendarTriggerWorkflow } from '@/lib/workflows/calendar-trigger-helpers';

type Kind = 'mcp_ key' | 'OAuth grant';

interface World {
  userId: string;
  driveId: string;
  agentId: string;
  taskListId: string;
  eventId: string;
  workflowId: string;
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, path: string, token: string, body: unknown) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function world(): Promise<World> {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const agent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Trigger agent', content: '' });
  const taskList = await factories.createPage(drive.id, { type: 'TASK_LIST', title: 'Tasks', content: '' });
  const [event] = await db.insert(calendarEvents).values({
    createdById: user.id, driveId: drive.id, title: 'Standup', timezone: 'UTC',
    startAt: new Date(Date.now() + 7 * 24 * 3600_000), endAt: new Date(Date.now() + 7 * 24 * 3600_000 + 3600_000),
  }).returning();
  const [workflow] = await db.insert(workflows).values({
    driveId: drive.id, createdBy: user.id, name: 'Session-authored', agentPageId: agent.id, prompt: 'go',
    contextPageIds: [], timezone: 'UTC', triggerType: 'cron', cronExpression: '0 9 * * *', isEnabled: false,
  }).returning();
  return { userId: user.id, driveId: drive.id, agentId: agent.id, taskListId: taskList.id, eventId: event.id, workflowId: workflow.id };
}

async function credential(kind: Kind, w: World): Promise<{ token: string; expected: unknown }> {
  if (kind === 'mcp_ key') {
    const mcp = generateToken('mcp');
    const [key] = await db.insert(mcpTokens).values({ userId: w.userId, tokenHash: mcp.hash, tokenPrefix: mcp.tokenPrefix, name: 'authoring key', isScoped: true }).returning();
    await db.insert(mcpTokenDrives).values({ tokenId: key.id, driveId: w.driveId, role: 'ADMIN' });
    return { token: mcp.token, expected: { kind: 'mcp', tokenId: key.id } };
  }
  const [client] = await db.insert(oauthClients).values({
    clientId: `app_${createId()}`, name: 'Authoring App', clientType: 'public', redirectUris: ['https://authoring.example/callback'],
    allowedGrantTypes: ['authorization_code'], allowedScopes: ['drive:admin'], ownerUserId: w.userId, verified: false,
  }).returning();
  const access = generateToken('ps_at');
  const familyId = createId();
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId, clientId: client.id, userId: w.userId,
    scopes: [`drive:${w.driveId}:admin`], tokenVersion: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return { token: access.token, expected: { kind: 'oauth', driveScopes: [{ driveId: w.driveId, role: 'ADMIN', customRoleId: null }], familyId } };
}

async function createTask(token: string, w: World, extra: Record<string, unknown> = {}): Promise<{ res: Response; taskId?: string }> {
  const res = await tasksPOST(req('POST', `/pages/${w.taskListId}/tasks`, token, { title: 'Ship it', ...extra }), params({ pageId: w.taskListId }));
  const body = (await res.clone().json().catch(() => ({}))) as { id?: string; task?: { id?: string } };
  return { res, taskId: body.task?.id ?? body.id };
}

/** Every trigger-authoring write, each returning its response. */
const WRITES: ReadonlyArray<{ name: string; run: (token: string, w: World) => Promise<Response> }> = [
  {
    name: 'POST /api/workflows',
    run: (t, w) => workflowsPOST(req('POST', '/workflows', t, { driveId: w.driveId, name: 'Nightly', agentPageId: w.agentId, prompt: 'summarize', cronExpression: '0 2 * * *', timezone: 'UTC', isEnabled: false })),
  },
  {
    name: 'PATCH /api/workflows/[workflowId]',
    run: async (t, w) => {
      const res = await workflowPATCH(req('PATCH', `/workflows/${w.workflowId}`, t, { prompt: 'summarize again' }), params({ workflowId: w.workflowId }));
      if (!res) throw new Error('PATCH returned no response');
      return res;
    },
  },
  {
    name: 'POST /api/pages/[pageId]/tasks (agentTrigger)',
    run: async (t, w) => (await createTask(t, w, { agentTrigger: { agentPageId: w.agentId, prompt: 'on completion', triggerType: 'completion' } })).res,
  },
  {
    name: 'PATCH /api/pages/[pageId]/tasks/[taskId] (agentTrigger)',
    run: async (t, w) => {
      const { taskId } = await createTask(t, w);
      if (!taskId) throw new Error('task create failed');
      return taskPATCH(req('PATCH', `/pages/${w.taskListId}/tasks/${taskId}`, t, { agentTrigger: { agentPageId: w.agentId, prompt: 'on completion', triggerType: 'completion' } }), params({ pageId: w.taskListId, taskId }));
    },
  },
  {
    name: 'PUT /api/tasks/[taskId]/triggers',
    run: async (t, w) => {
      const { taskId } = await createTask(t, w);
      if (!taskId) throw new Error('task create failed');
      return taskTriggerPUT(req('PUT', `/tasks/${taskId}/triggers`, t, { triggerType: 'completion', agentPageId: w.agentId, prompt: 'on completion', timezone: 'UTC' }), params({ taskId }));
    },
  },
  {
    // The UPDATE branch: a trigger the user armed as themself, re-authored by the credential.
    name: 'PUT /api/tasks/[taskId]/triggers over a session-authored trigger',
    run: async (t, w) => {
      const { taskId } = await createTask(t, w);
      if (!taskId) throw new Error('task create failed');
      await createTaskTriggerWorkflow({
        database: db, driveId: w.driveId, userId: w.userId, taskId, taskMetadata: null, dueDate: null, timezone: 'UTC',
        agentTrigger: { agentPageId: w.agentId, prompt: 'armed by the user', triggerType: 'completion' }, credentialCeiling: null,
      });
      return taskTriggerPUT(req('PUT', `/tasks/${taskId}/triggers`, t, { triggerType: 'completion', agentPageId: w.agentId, prompt: 'on completion', timezone: 'UTC' }), params({ taskId }));
    },
  },
  {
    name: 'PUT /api/calendar/events/[eventId]/triggers over a session-authored trigger',
    run: async (t, w) => {
      await upsertCalendarTriggerWorkflow(db, {
        driveId: w.driveId, scheduledById: w.userId, calendarEventId: w.eventId, triggerAt: new Date(Date.now() + 7 * 24 * 3600_000), timezone: 'UTC',
        agentTrigger: { agentPageId: w.agentId, prompt: 'armed by the user' }, credentialCeiling: null,
      });
      return eventTriggerPUT(req('PUT', `/calendar/events/${w.eventId}/triggers`, t, { agentPageId: w.agentId, prompt: 'prep the standup' }), params({ eventId: w.eventId }));
    },
  },
  {
    name: 'POST /api/calendar/events (agentTrigger)',
    run: (t, w) => eventsPOST(req('POST', '/calendar/events', t, {
      driveId: w.driveId, title: 'Review', timezone: 'UTC',
      startAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(), endAt: new Date(Date.now() + 3 * 24 * 3600_000 + 3600_000).toISOString(),
      agentTrigger: { agentPageId: w.agentId, prompt: 'prep the review' },
    })),
  },
  {
    name: 'PATCH /api/calendar/events/[eventId] (agentTrigger)',
    run: (t, w) => eventPATCH(req('PATCH', `/calendar/events/${w.eventId}`, t, { agentTrigger: { agentPageId: w.agentId, prompt: 'prep the standup' } }), params({ eventId: w.eventId })),
  },
  {
    name: 'PUT /api/calendar/events/[eventId]/triggers',
    run: (t, w) => eventTriggerPUT(req('PUT', `/calendar/events/${w.eventId}/triggers`, t, { agentPageId: w.agentId, prompt: 'prep the standup' }), params({ eventId: w.eventId })),
  },
];

beforeAll(async () => {
  await ensureTestDb();
});

describe.each<Kind>(['mcp_ key', 'OAuth grant'])('a %s (ADMIN in the drive) authoring a deferred run persists its ceiling', (kind) => {
  it.each(WRITES.map((write) => [write.name, write] as const))('%s', async (_name, write) => {
    const w = await world();
    const { token, expected } = await credential(kind, w);

    const res = await write.run(token, w);
    expect(res.status, (await res.clone().text()).slice(0, 400)).toBeLessThan(300);

    const authored = (await db.select({ id: workflows.id, credentialCeiling: workflows.credentialCeiling }).from(workflows).where(eq(workflows.driveId, w.driveId)))
      .filter((row) => row.id !== w.workflowId || write.name.startsWith('PATCH /api/workflows'));
    expect(authored.length).toBeGreaterThan(0);
    for (const row of authored) expect(row.credentialCeiling).toEqual(expected);
  }, 30_000);
});

/** The same authoring through the AGENT TOOLS, under a context built from the credential at the door. */
async function toolContext(token: string, w: World): Promise<ToolExecutionContext> {
  const auth = await authenticateRequestWithOptions(req('POST', '/ai/page-agents/consult', token, {}), { allow: ['mcp', 'oauth'] });
  if (isAuthError(auth)) throw new Error('credential did not authenticate');
  return { userId: w.userId, timezone: 'UTC', ...toolCredentialScope(auth) } as ToolExecutionContext;
}

const runTool = async (name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Record<string, unknown>> => {
  const execute = (pageSpaceTools as Record<string, { execute?: unknown }>)[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  return execute(args, { toolCallId: createId(), messages: [], experimental_context: ctx });
};

const taskIdOf = (result: Record<string, unknown>): string => {
  const task = result.task as { id?: string } | undefined;
  const id = task?.id ?? (result.taskId as string | undefined) ?? (result.id as string | undefined);
  if (!id) throw new Error(`no task id in ${JSON.stringify(result).slice(0, 300)}`);
  return id;
};

const TOOL_WRITES: ReadonlyArray<{ name: string; run: (ctx: ToolExecutionContext, w: World) => Promise<unknown> }> = [
  { name: 'create_workflow', run: (c, w) => runTool('create_workflow', { driveId: w.driveId, name: 'Tool nightly', cronExpression: '0 3 * * *', timezone: 'UTC', agentTrigger: { agentPageId: w.agentId, prompt: 'summarize' } }, c) },
  { name: 'update_workflow', run: (c, w) => runTool('update_workflow', { workflowId: w.workflowId, name: 'Renamed by tool' }, c) },
  { name: 'create_task (agentTrigger)', run: (c, w) => runTool('create_task', { pageId: w.taskListId, title: 'Tool task', agentTrigger: { agentPageId: w.agentId, prompt: 'on completion', triggerType: 'completion' } }, c) },
  {
    name: 'update_task (agentTrigger)',
    run: async (c, w) => {
      const taskId = taskIdOf(await runTool('create_task', { pageId: w.taskListId, title: 'Tool task' }, c));
      return runTool('update_task', { taskId, agentTrigger: { agentPageId: w.agentId, prompt: 'on completion', triggerType: 'completion' } }, c);
    },
  },
  {
    name: 'set_task_trigger',
    run: async (c, w) => {
      const taskId = taskIdOf(await runTool('create_task', { pageId: w.taskListId, title: 'Tool task' }, c));
      return runTool('set_task_trigger', { taskId, triggerType: 'completion', agentPageId: w.agentId, prompt: 'on completion' }, c);
    },
  },
  { name: 'set_calendar_trigger (existing event)', run: (c, w) => runTool('set_calendar_trigger', { calendarEventId: w.eventId, agentPageId: w.agentId, prompt: 'prep' }, c) },
  { name: 'set_calendar_trigger (new event)', run: (c, w) => runTool('set_calendar_trigger', { triggerAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(), driveId: w.driveId, timezone: 'UTC', agentPageId: w.agentId, prompt: 'prep' }, c) },
  {
    name: 'create_calendar_event (agentTrigger)',
    run: (c, w) => runTool('create_calendar_event', {
      title: 'Tool review', driveId: w.driveId, timezone: 'UTC',
      startAt: new Date(Date.now() + 4 * 24 * 3600_000).toISOString(), endAt: new Date(Date.now() + 4 * 24 * 3600_000 + 3600_000).toISOString(),
      agentTrigger: { agentPageId: w.agentId, prompt: 'prep' },
    }, c),
  },
  { name: 'update_calendar_event (agentTrigger)', run: (c, w) => runTool('update_calendar_event', { eventId: w.eventId, agentTrigger: { agentPageId: w.agentId, prompt: 'prep again' } }, c) },
];

describe.each<Kind>(['mcp_ key', 'OAuth grant'])('an agent tool acting for a %s (ADMIN in the drive) authoring a deferred run persists its ceiling', (kind) => {
  it.each(TOOL_WRITES.map((write) => [write.name, write] as const))('%s', async (_name, write) => {
    const w = await world();
    const { token, expected } = await credential(kind, w);
    const ctx = await toolContext(token, w);

    const result = await write.run(ctx, w);
    expect((result as { success?: unknown }).success, JSON.stringify(result).slice(0, 400)).not.toBe(false);

    const authored = (await db.select({ id: workflows.id, credentialCeiling: workflows.credentialCeiling }).from(workflows).where(eq(workflows.driveId, w.driveId)))
      .filter((row) => row.id !== w.workflowId || write.name === 'update_workflow');
    expect(authored.length).toBeGreaterThan(0);
    for (const row of authored) expect(row.credentialCeiling).toEqual(expected);
  }, 30_000);
});
