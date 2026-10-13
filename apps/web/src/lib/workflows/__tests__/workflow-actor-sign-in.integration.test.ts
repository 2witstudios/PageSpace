// @vitest-environment node
/**
 * Who a workflow run acts as, against PostgreSQL (D-OW-34, D-OW-62).
 *
 *  - Pressing Run is the caller acting: the real Run route runs the workflow as the request's credential, so an org's
 *    sign-in policy applies to its steps exactly as to that request.
 *  - A scheduled or triggered run has nobody signing in: it runs as the creator, an automation CONFINED to the
 *    workflow's drive, so it can never reach another drive the creator holds — signed-in-only org drive or not.
 *
 * Every workflow here is a deterministic `send_channel_message` chain (no model, no credit hold), executed by the real
 * executor and the real tool with its real permission checks. A channel post rather than a page edit because a page
 * edit snapshots content to object storage this environment has no credentials for (as deterministic-webhook-e2e).
 * Faked, and only this: realtime broadcasts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { channelMessages } from '@pagespace/db/schema/chat';
import { users } from '@pagespace/db/schema/auth';
import { workflows, type WorkflowStep } from '@pagespace/db/schema/workflows';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { webhookTriggers } from '@pagespace/db/schema/webhook-triggers';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

vi.mock('@/lib/websocket', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) stubbed[name] = typeof value === 'function' && name.startsWith('broadcast') ? vi.fn(async () => {}) : value;
  return stubbed;
});

// The tool registry and the workflow executor import each other; load the registry first, as the app's agent routes do.
import '@/lib/ai/core/ai-tools';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { executePageWebhookTrigger } from '@/lib/webhooks/page-webhook-trigger-executor';
import { POST as runWorkflow } from '@/app/api/workflows/[workflowId]/run/route';

const MARK = 'WRITTEN-BY-RUN';
const created = { users: [] as string[], orgs: [] as string[] };

/** A person with a personal drive (where the workflow lives), a second personal drive, and an Acme org drive whose org requires a passkey sign-in. */
async function fixture() {
  const person = await factories.createUser();
  created.users.push(person.id);
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId: person.id, policies: { requireStrongSignIn: true } }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: person.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(person.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Acme general', type: 'CHANNEL', content: '' });
  const home = await factories.createDrive(person.id);
  const homePage = await factories.createPage(home.id, { title: 'Home', type: 'CHANNEL', content: '' });
  const other = await factories.createDrive(person.id);
  const otherPage = await factories.createPage(other.id, { title: 'Other', type: 'CHANNEL', content: '' });
  return { person, orgPage, home, homePage, otherPage };
}

const appendTo = (channel: { id: string }): WorkflowStep =>
  ({ kind: 'tool', toolName: 'send_channel_message', args: { channelId: channel.id, content: MARK } });

async function workflowIn(driveId: string, createdBy: string, steps: WorkflowStep[]) {
  const [row] = await db.insert(workflows).values({
    driveId, createdBy, name: 'Append', agentPageId: null, prompt: '', steps, cronExpression: '0 9 * * *', timezone: 'UTC', isEnabled: false,
  }).returning();
  return row;
}

const contentOf = async (channelId: string) =>
  (await db.select({ content: channelMessages.content }).from(channelMessages)
    .where(and(eq(channelMessages.pageId, channelId), eq(channelMessages.isActive, true)))).map((row) => row.content).join('\n');

const session = (userId: string, authentication: VerifiedAuthentication) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 3_600_000, authentication });

async function pressRun(workflowId: string, token: string) {
  const res = await runWorkflow(
    new Request(`https://app.test/api/workflows/${workflowId}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ workflowId }) },
  );
  return { status: res.status, body: (await res.json()) as { success?: boolean; error?: string } };
}

const scheduledRun = (workflow: typeof workflows.$inferSelect) => executeWorkflow({
  workflowId: workflow.id, workflowName: workflow.name, driveId: workflow.driveId, createdBy: workflow.createdBy ?? '',
  agentPageId: null, prompt: '', steps: workflow.steps, contextPageIds: [], instructionPageId: null, timezone: 'UTC',
  source: { table: 'cron', id: null, triggerAt: new Date() },
});

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('SEC-2 (partial) a manual workflow Run acts as the caller\'s credential (D-OW-62)', () => {
  it('SEC-2 (partial) a magic-link session\'s Run cannot write a passkey-only org page; a passkey session\'s Run can', async () => {
    const { person, orgPage, home } = await fixture();
    const workflow = await workflowIn(home.id, person.id, [appendTo(orgPage)]);

    const weak = await pressRun(workflow.id, await session(person.id, { authenticatedAtMs: Date.now(), assurance: 'single_factor' }));
    expect(weak.status).toBe(200);
    expect(weak.body.success).toBe(false);
    expect(weak.body.error).toContain('Insufficient permissions');
    expect(await contentOf(orgPage.id)).not.toContain(MARK);

    const strong = await pressRun(workflow.id, await session(person.id, { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' }));
    expect(strong.status).toBe(200);
    expect(strong.body.success).toBe(true);
    expect(await contentOf(orgPage.id)).toContain(MARK);
  });
});

describe('SEC-3 (partial) a scheduled or triggered run is confined to its workflow\'s drive (D-OW-34)', () => {
  it('SEC-3 (partial) a scheduled run writes its own drive but neither another drive its creator owns nor their org drive', async () => {
    const { person, orgPage, home, homePage, otherPage } = await fixture();

    const own = await scheduledRun(await workflowIn(home.id, person.id, [appendTo(homePage)]));
    expect(own.success).toBe(true);
    expect(await contentOf(homePage.id)).toContain(MARK);

    const toOther = await scheduledRun(await workflowIn(home.id, person.id, [appendTo(otherPage)]));
    expect(toOther.success).toBe(false);
    expect(toOther.error).toContain('Insufficient permissions');
    expect(await contentOf(otherPage.id)).not.toContain(MARK);

    const toOrg = await scheduledRun(await workflowIn(home.id, person.id, [appendTo(orgPage)]));
    expect(toOrg.success).toBe(false);
    expect(toOrg.error).toContain('Insufficient permissions');
    expect(await contentOf(orgPage.id)).not.toContain(MARK);
  });

  it('SEC-3 (partial) a page-webhook fire cannot reach outside its workflow\'s drive', async () => {
    const { person, home, homePage, otherPage } = await fixture();
    const [webhook] = await db.insert(pageWebhooks).values({ pageId: homePage.id, name: 'Inbound', webhookSecretEncrypted: 'unused-by-the-executor', createdBy: person.id }).returning();
    const fire = async (steps: WorkflowStep[]) => {
      const workflow = await workflowIn(home.id, person.id, steps);
      const [trigger] = await db.insert(webhookTriggers).values({ workflowId: workflow.id, pageWebhookId: webhook.id, provider: 'page', eventType: 'page.webhook' }).returning();
      return executePageWebhookTrigger(trigger, { event: 'ping' });
    };

    const own = await fire([appendTo(homePage)]);
    expect(own.success).toBe(true);

    const away = await fire([appendTo(otherPage)]);
    expect(away.success).toBe(false);
    expect(away.error).toContain('Insufficient permissions');
    expect(await contentOf(otherPage.id)).not.toContain(MARK);
  });
});
