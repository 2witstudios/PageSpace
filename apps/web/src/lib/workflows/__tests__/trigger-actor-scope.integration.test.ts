// @vitest-environment node
/**
 * Calendar and Zoom triggers run as an automation CONFINED to their workflow's drive (D-OW-34, D-OW-62), against
 * PostgreSQL. Both are AI-only: the real trigger executor loads the workflow, checks the scheduler or connection
 * owner still holds the drive, and hands the run to the real workflow executor, whose agent calls the real
 * `read_page` tool with its real permission checks.
 *
 * The person owns three drives: the workflow's drive (where the agent lives), a second personal drive, and an Acme
 * org drive whose org requires a passkey sign-in. A triggered run may read its own drive only: the other two are
 * outside its scope, whatever the person could open when signed in.
 *
 * Faked, and only these: the language model (a mock that issues one `read_page` call for the page under test and
 * then stops), the trigger's credit gate and usage billing (wallet machinery, not access), and realtime broadcasts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { MockLanguageModelV3 } from 'ai/test';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { workflows } from '@pagespace/db/schema/workflows';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { webhookTriggers } from '@pagespace/db/schema/webhook-triggers';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';

const model = vi.hoisted(() => ({ targetPageId: '', toolResults: [] as string[] }));

/** A model that reads the page under test once, records what the tool handed back, and stops. */
function readTargetPageModel() {
  let step = 0;
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: 'tool-call', toolCallId: `call-${createId()}`, toolName: 'read_page', input: JSON.stringify({ title: 'Target', pageId: model.targetPageId }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      model.toolResults.push(JSON.stringify(options.prompt.filter((message) => message.role === 'tool')));
      return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    },
  });
}

vi.mock('@/lib/ai/core/provider-factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/core/provider-factory')>()),
  createAIProvider: vi.fn(async () => ({ model: readTargetPageModel(), provider: 'mock', modelName: 'mock' })),
}));
vi.mock('@pagespace/lib/billing/credit-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/billing/credit-gate')>()),
  canConsumeAI: vi.fn(async () => ({ allowed: true, holdId: null, walletId: 'test-wallet' })),
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: vi.fn(async () => {}) } }));
vi.mock('@/lib/websocket', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) stubbed[name] = typeof value === 'function' && name.startsWith('broadcast') ? vi.fn(async () => {}) : value;
  return stubbed;
});

// The tool registry and the workflow executor import each other; load the registry first, as the app's agent routes do.
import '@/lib/ai/core/ai-tools';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { executeWebhookTrigger } from '@/lib/integrations/zoom/webhook-trigger-executor';

const created = { users: [] as string[], orgs: [] as string[] };

/** The person, their workflow drive with an agent that is a member of all three of their drives, and one page in each. */
async function fixture() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId: person.id, policies: { requireStrongSignIn: true } }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgDoc = await factories.createPage(orgDrive.id, { title: 'Roadmap', content: 'ACME-ORG-SECRET' });
  const home = await factories.createDrive(person.id);
  const homeDoc = await factories.createPage(home.id, { title: 'Notes', content: 'HOME-NOTES-READABLE' });
  const agent = await factories.createPage(home.id, { title: 'Helper', type: 'AI_CHAT', content: '', enabledTools: ['read_page'] });
  const other = await factories.createDrive(person.id);
  const otherDoc = await factories.createPage(other.id, { title: 'Diary', content: 'OTHER-DRIVE-SECRET' });
  // The agent is a member of all three drives, so its own reach would admit every read: only the run's scope refuses.
  await db.insert(driveAgentMembers).values([home, other, orgDrive].map((drive) => ({ driveId: drive.id, agentPageId: agent.id, role: 'MEMBER' as const, addedBy: person.id })));
  const [workflow] = await db.insert(workflows).values({
    driveId: home.id, createdBy: person.id, name: 'Triggered', agentPageId: agent.id, prompt: 'Read the target page.', timezone: 'UTC', isEnabled: true,
  }).returning();
  return { person, home, workflow, homeDoc, otherDoc, orgDoc };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Point the model at `pageId`, fire, and return the run and what `read_page` handed back. */
async function readVia(fire: () => Promise<{ success: boolean; error?: string }>, pageId: string) {
  model.targetPageId = pageId;
  model.toolResults = [];
  const result = await fire();
  return { result, toolResult: model.toolResults.join('\n') };
}

async function calendarFire(f: Fixture) {
  const [event] = await db.insert(calendarEvents).values({
    driveId: f.home.id, createdById: f.person.id, title: 'Standup', startAt: new Date(), endAt: new Date(Date.now() + 1_800_000),
  }).returning();
  const [trigger] = await db.insert(calendarTriggers).values({
    workflowId: f.workflow.id, calendarEventId: event.id, driveId: f.home.id, scheduledById: f.person.id, triggerAt: new Date(), occurrenceDate: new Date(),
  }).returning();
  return () => executeCalendarTrigger(trigger, event);
}

async function zoomFire(f: Fixture) {
  const [connection] = await db.insert(zoomConnections).values({
    userId: f.person.id, accessToken: 'unused-by-the-executor', zoomUserId: `zu-${createId()}`, zoomAccountId: `za-${createId()}`, zoomEmail: 'host@example.test', targetDriveId: f.home.id,
  }).returning();
  const [trigger] = await db.insert(webhookTriggers).values({
    workflowId: f.workflow.id, connectionId: connection.id, provider: 'zoom', eventType: 'recording.transcript_completed',
  }).returning();
  return () => executeWebhookTrigger(trigger, { event: 'recording.transcript_completed', payload: { topic: 'Standup' } }, connection);
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe.each([
  ['calendar trigger', calendarFire],
  ['Zoom webhook trigger', zoomFire],
] as const)('SEC-3 (partial) a %s run is confined to its workflow\'s drive (D-OW-34, D-OW-62)', (name, arm) => {
  it(`SEC-3 (partial) a ${name} run reads its own drive, but neither another drive its owner holds nor their passkey-only org drive`, async () => {
    const f = await fixture();
    const fire = await arm(f);

    const own = await readVia(fire, f.homeDoc.id);
    expect(own.result.error).toBeUndefined();
    expect(own.result.success).toBe(true);
    expect(own.toolResult).toContain('HOME-NOTES-READABLE');

    const other = await readVia(fire, f.otherDoc.id);
    expect(other.toolResult).toContain('Insufficient permissions');
    expect(other.toolResult).not.toContain('OTHER-DRIVE-SECRET');

    const org = await readVia(fire, f.orgDoc.id);
    expect(org.toolResult).toContain('Insufficient permissions');
    expect(org.toolResult).not.toContain('ACME-ORG-SECRET');
  }, 60_000);
});
