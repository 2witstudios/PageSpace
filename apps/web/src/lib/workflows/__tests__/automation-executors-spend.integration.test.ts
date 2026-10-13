/**
 * Every automation executor against a real Postgres with wallets live (Spec SPEND-6; [D-OW-34], [D-OW-36]).
 *
 * Northwind: Jono owns the org; Lena leads Product (an Open org drive) and is told of skips; Marcus, a
 * member, built every automation in it; Priya, a member who administers the drive, presses Run and
 * @mentions the agent. Each executor is driven through its REAL entry point — the workflows cron, the
 * task-triggers cron, the page-webhook executor, the calendar-trigger executor, the channel-mention
 * responder and the manual Run route — and the gate, holds, settlement, caps, skip notices and the
 * departure sweep are all real. Faked: the model (generateText) and its provider, the cron signature,
 * the session behind the Run route, and outbound realtime/side effects nothing here reads.
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generateTextMock,
}));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({ model: {}, provider: 'anthropic', modelName: 'anthropic/claude-sonnet-5' })),
  isProviderError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: () => null }));
const session = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: session.userId, tokenType: 'session', sessionId: 's', role: 'user', tokenVersion: 0, adminRoleVersion: 0 })),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { webhookTriggers, PAGE_WEBHOOK_EVENT_TYPE } from '@pagespace/db/schema/webhook-triggers';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { automationSkipNotices, walletCapAlerts, walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { leaveOrganization } from '@pagespace/lib/organizations/leave';
import { setDriveWalletCap } from '@pagespace/lib/services/drive-wallet-service';
import { POST as cronWorkflows } from '@/app/api/cron/workflows/route';
import { POST as cronTaskTriggers } from '@/app/api/cron/task-triggers/route';
import { POST as manualRun } from '@/app/api/workflows/[workflowId]/run/route';
import { executePageWebhookTrigger } from '@/lib/webhooks/page-webhook-trigger-executor';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { triggerMentionedAgentResponses } from '@/lib/channels/agent-mention-responder';
import { encodeAutomationRef } from '@pagespace/lib/billing/automation-attribution';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const originalMode = process.env.DEPLOYMENT_MODE;
const DAY = 86_400_000;
const PERSONAL_CENTS = 5_000;
let dbAvailable = false;

interface World {
  orgId: string;
  productId: string;
  jonoId: string;
  lenaId: string;
  marcusId: string;
  priyaId: string;
  poolId: string;
  productWalletId: string;
  marcusRootId: string;
  priyaRootId: string;
  agentId: string;
  channelId: string;
  hourlyId: string;
  taskWorkflowId: string;
  taskTriggerId: string;
  webhookWorkflowId: string;
  webhookTriggerId: string;
  calendarWorkflowId: string;
  calendarTriggerId: string;
  userIds: string[];
}
let world: World | null = null;

async function build(productAllocationCents = 10_000): Promise<World> {
  const [jono, lena, marcus, priya] = await Promise.all([
    factories.createUser({ name: 'Jono', subscriptionTier: 'pro' }),
    factories.createUser({ name: 'Lena Lead', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Priya Nair', subscriptionTier: 'free' }),
  ]);
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, stripeCustomerId: `cus_${createId()}` }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: priya.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, priya.id, { source: 'org', role: 'ADMIN' });
  const now = Date.now();
  const [pool] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, monthlyRemainingCents: 50_000,
    monthlyPeriodStart: new Date(now - 10 * DAY), monthlyPeriodEnd: new Date(now + 20 * DAY),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: pool.id, monthlyAllowanceCents: productAllocationCents,
    monthlyPeriodStart: new Date(now - 10 * DAY), monthlyPeriodEnd: new Date(now + 20 * DAY),
  }).returning();
  const roots = await db.insert(wallets).values([marcus, priya].map((u) => ({
    userId: u.id, monthlyRemainingCents: PERSONAL_CENTS, monthlyPeriodStart: new Date(now - DAY), monthlyPeriodEnd: new Date(now + 20 * DAY),
  }))).returning();

  // An agent that may post in channels, a MEMBER of the drive as itself, so a mention can reach it.
  const agent = await factories.createPage(product.id, { title: 'Ops Agent', type: 'AI_CHAT', enabledTools: ['send_channel_message'] });
  await db.insert(driveAgentMembers).values({ driveId: product.id, agentPageId: agent.id, role: 'MEMBER', addedBy: lena.id });
  const channel = await factories.createPage(product.id, { title: 'ops', type: 'CHANNEL' });
  // Marcus's automations, each driven by its own executor.
  const [hourly] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, agentPageId: agent.id, name: 'Hourly digest', prompt: 'summarize', cronExpression: '0 * * * *', nextRunAt: new Date(now - 60_000) }).returning();
  const listPage = await factories.createPage(product.id, { title: 'Roadmap', type: 'TASK_LIST' });
  await db.insert(taskLists).values({ userId: marcus.id, pageId: listPage.id, title: 'Roadmap' });
  const taskPage = await factories.createPage(product.id, { title: 'Ship it', type: 'TASK_LIST', parentId: listPage.id });
  const [task] = await db.insert(taskItems).values({ userId: marcus.id, pageId: taskPage.id, dueDate: new Date(now - 60_000) }).returning();
  const [taskWorkflow] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, agentPageId: agent.id, name: 'task-trigger', prompt: 'nudge the assignee', triggerType: 'event' }).returning();
  const [taskTrigger] = await db.insert(taskTriggers).values({ workflowId: taskWorkflow.id, taskItemId: task.id, triggerType: 'due_date', nextRunAt: new Date(now - 60_000) }).returning();
  const [webhookWorkflow] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, agentPageId: agent.id, name: 'CI webhook', prompt: 'triage the build', triggerType: 'event' }).returning();
  const [webhook] = await db.insert(pageWebhooks).values({ pageId: channel.id, name: 'CI', webhookSecretEncrypted: 'enc', createdBy: marcus.id }).returning();
  const [webhookTrigger] = await db.insert(webhookTriggers).values({ workflowId: webhookWorkflow.id, pageWebhookId: webhook.id, provider: 'page-webhook', eventType: PAGE_WEBHOOK_EVENT_TYPE, isEnabled: true }).returning();
  const [calendarWorkflow] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, agentPageId: agent.id, name: 'calendar-trigger', prompt: 'prep the standup', triggerType: 'event' }).returning();
  const [event] = await db.insert(calendarEvents).values({ driveId: product.id, createdById: marcus.id, title: 'Standup', startAt: new Date(now + DAY), endAt: new Date(now + DAY + 3_600_000) }).returning();
  const [calendarTrigger] = await db.insert(calendarTriggers).values({ workflowId: calendarWorkflow.id, calendarEventId: event.id, driveId: product.id, scheduledById: marcus.id, triggerAt: new Date(now - 60_000) }).returning();

  return {
    orgId: org.id, productId: product.id, jonoId: jono.id, lenaId: lena.id, marcusId: marcus.id, priyaId: priya.id,
    poolId: pool.id, productWalletId: productWallet.id, marcusRootId: roots[0].id, priyaRootId: roots[1].id,
    agentId: agent.id, channelId: channel.id, hourlyId: hourly.id, taskWorkflowId: taskWorkflow.id, taskTriggerId: taskTrigger.id,
    webhookWorkflowId: webhookWorkflow.id, webhookTriggerId: webhookTrigger.id, calendarWorkflowId: calendarWorkflow.id, calendarTriggerId: calendarTrigger.id,
    userIds: [jono.id, lena.id, marcus.id, priya.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(automationSkipNotices).where(eq(automationSkipNotices.driveId, w.productId));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(walletCapAlerts).where(inArray(walletCapAlerts.walletId, [w.poolId, w.productWalletId]));
  await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [w.poolId, w.productWalletId]));
  await db.delete(workflows).where(eq(workflows.driveId, w.productId));
  await db.delete(calendarEvents).where(eq(calendarEvents.driveId, w.productId));
  await db.delete(taskLists).where(inArray(taskLists.pageId, db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.productId))));
  await db.delete(wallets).where(eq(wallets.id, w.productWalletId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.id, w.productId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const usageRows = (w: World) => db.select().from(creditLedger).where(and(inArray(creditLedger.userId, w.userIds), eq(creditLedger.entryType, 'usage')));
const liveHolds = (w: World) => db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds));
const lastRun = async (workflowId: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).orderBy(sql`${workflowRuns.startedAt} desc`).limit(1))[0] ?? null;
const leadSkipReasons = async (w: World) =>
  (await db.select().from(notifications).where(and(eq(notifications.userId, w.lenaId), sql`${notifications.type} = 'AUTOMATION_SKIPPED'`)))
    .map((n) => (n.metadata as { reason: string }).reason);
const cronRequest = () => new Request('https://example.com/api/cron', { method: 'POST' });

/** Nobody's own credits and no seat moved: the people's roots are whole and no usage landed off the drive wallet. */
async function expectNoPersonCharged(w: World): Promise<void> {
  expect((await walletRow(w.marcusRootId)).monthlyRemainingCents).toBe(PERSONAL_CENTS);
  expect((await walletRow(w.priyaRootId)).monthlyRemainingCents).toBe(PERSONAL_CENTS);
  expect((await usageRows(w)).filter((r) => r.walletId !== w.productWalletId)).toEqual([]);
}

async function runEveryAutomation(w: World) {
  const [webhookTrigger] = await db.select().from(webhookTriggers).where(eq(webhookTriggers.id, w.webhookTriggerId));
  const [calendarTrigger] = await db.select().from(calendarTriggers).where(eq(calendarTriggers.id, w.calendarTriggerId));
  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, calendarTrigger.calendarEventId));
  return {
    cron: await (await cronWorkflows(cronRequest())).json(),
    task: await (await cronTaskTriggers(cronRequest())).json(),
    webhook: await executePageWebhookTrigger(webhookTrigger, { build: 'red' }),
    calendar: await executeCalendarTrigger(calendarTrigger, event),
  };
}

const mention = (w: World, userId: string) =>
  triggerMentionedAgentResponses({
    sender: credentialActor(userId, null),
    channelId: w.channelId,
    channelTitle: 'ops',
    sourceMessageId: createId(),
    content: `@[Ops Agent](${w.agentId}:page) what broke?`,
    driveId: w.productId,
    driveName: 'Product',
  });

describe('SPEND-6 automations, triggers and scheduled workflows spend the drive wallet only, run as their creator under the creator\'s cap; a mention or a manual Run is the person\'s and counts against their cap; a departed creator\'s automations are disabled, flagged and never run; an empty wallet or a reached cap skips and logs why', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: workflows.id }).from(workflows).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('automation-executors-spend.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEPLOYMENT_MODE = 'cloud';
    generateTextMock.mockResolvedValue({
      text: 'done',
      steps: [{ text: 'done', toolCalls: [] }],
      usage: { inputTokens: 20_000, outputTokens: 2_000 },
      response: { messages: [] },
      finishReason: 'stop',
    });
  });

  afterEach(async () => {
    if (world) await teardown(world);
    world = null;
  });

  afterAll(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('every executor — the workflows cron, the task-trigger cron, a page webhook, a calendar trigger — reserves and settles on the drive wallet as the creator, never a person\'s own credits or seat', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const ran = await runEveryAutomation(w);
    expect(await lastRun(w.hourlyId)).toMatchObject({ status: 'success' });
    expect(await lastRun(w.taskWorkflowId)).toMatchObject({ status: 'success' });
    expect(ran.webhook).toMatchObject({ success: true });
    expect(ran.calendar).toMatchObject({ success: true });

    const usage = await usageRows(w);
    expect(usage).toHaveLength(4);
    for (const row of usage) expect(row).toMatchObject({ walletId: w.productWalletId, userId: w.marcusId });
    expect(new Set(usage.map((r) => r.automationRef))).toEqual(new Set([w.hourlyId, w.taskWorkflowId, w.webhookWorkflowId, w.calendarWorkflowId].map((workflowId) => encodeAutomationRef({ kind: 'workflow', workflowId }))));
    expect((await walletRow(w.productWalletId)).spentCents).toBeGreaterThan(0);
    await expectNoPersonCharged(w);
    expect(await liveHolds(w)).toEqual([]);
  });

  it('a channel @mention and a manual Run spend the drive wallet as the person who caused them, never their own credits', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await mention(w, w.priyaId);
    session.userId = w.priyaId;
    const run = await manualRun(new Request(`https://example.com/api/workflows/${w.hourlyId}/run`, { method: 'POST' }), { params: Promise.resolve({ workflowId: w.hourlyId }) });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ success: true });

    const usage = await usageRows(w);
    expect(usage.length).toBeGreaterThanOrEqual(2);
    for (const row of usage) expect(row).toMatchObject({ walletId: w.productWalletId, userId: w.priyaId, automationRef: null });
    await expectNoPersonCharged(w);
  });

  it('the creator\'s cap binds their automations; the presser\'s and the sender\'s own caps bind their Run and mention, not the creator\'s; a reached cap skips, records why and tells the lead', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    expect(await setDriveWalletCap(credentialActor(w.jonoId, null), w.productId, w.marcusId, { dailyCents: 0, monthlyCents: null }, 'session')).toMatchObject({ ok: true });

    const ran = await runEveryAutomation(w);
    expect(await lastRun(w.hourlyId)).toMatchObject({ status: 'cancelled', error: expect.stringContaining('source_cap_reached') });
    expect(ran.webhook).toMatchObject({ success: false, error: expect.stringContaining('source_cap_reached') });
    expect(ran.calendar).toMatchObject({ success: false, error: expect.stringContaining('source_cap_reached') });
    expect(await lastRun(w.taskWorkflowId)).toMatchObject({ status: 'cancelled', error: expect.stringContaining('source_cap_reached') });
    expect(await usageRows(w)).toEqual([]);
    expect(await leadSkipReasons(w)).toEqual(['source_cap_reached']);

    // Marcus's cap is his: Priya's Run of his workflow and her mention are hers to pay, under her cap.
    session.userId = w.priyaId;
    const runAsPriya = () => manualRun(new Request(`https://example.com/api/workflows/${w.hourlyId}/run`, { method: 'POST' }), { params: Promise.resolve({ workflowId: w.hourlyId }) });
    expect((await runAsPriya()).status).toBe(200);
    expect((await usageRows(w)).map((r) => r.userId)).toEqual([w.priyaId]);
    await setDriveWalletCap(credentialActor(w.jonoId, null), w.productId, w.priyaId, { dailyCents: 0, monthlyCents: null }, 'session');
    expect((await runAsPriya()).status).not.toBe(200);
    const charged = (await usageRows(w)).length;
    await mention(w, w.priyaId);
    expect((await usageRows(w)).length).toBe(charged);
    await expectNoPersonCharged(w);
  });

  it('an empty drive wallet skips every automation, records why on the run and tells the lead once; nothing falls to a person', async () => {
    if (!dbAvailable) return;
    const w = (world = await build(0));
    const ran = await runEveryAutomation(w);
    expect(await lastRun(w.hourlyId)).toMatchObject({ status: 'cancelled', error: expect.stringContaining('drive_wallet_empty') });
    expect(ran.webhook).toMatchObject({ success: false, error: expect.stringContaining('drive_wallet_empty') });
    expect(ran.calendar).toMatchObject({ success: false, error: expect.stringContaining('drive_wallet_empty') });
    await mention(w, w.priyaId);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await usageRows(w)).toEqual([]);
    expect(await leadSkipReasons(w)).toEqual(['drive_wallet_empty']);
    await expectNoPersonCharged(w);
  });

  it('a creator who leaves the org: their org-drive automations are disabled and flagged owner-left, and none runs — on any executor', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await leaveOrganization(w.marcusId, w.orgId);
    const mine = await db.select().from(workflows).where(eq(workflows.createdBy, w.marcusId));
    expect(mine.length).toBe(4);
    for (const wf of mine) {
      expect(wf.isEnabled, wf.name).toBe(false);
      expect(wf.ownerLeftAt, wf.name).not.toBeNull();
    }

    const ran = await runEveryAutomation(w);
    // The owner-left workflow is not even picked up by the cron sweep, and the task trigger retires.
    expect(await lastRun(w.hourlyId)).toBeNull();
    expect((await db.select().from(taskTriggers).where(eq(taskTriggers.id, w.taskTriggerId)))[0]).toMatchObject({ isEnabled: false });
    expect(ran.webhook).toMatchObject({ success: false, skipped: true });
    expect(ran.calendar).toMatchObject({ success: false, skipped: true });
    // A Run of a departed creator's workflow is refused before any gate.
    session.userId = w.priyaId;
    expect((await manualRun(new Request(`https://example.com/api/workflows/${w.hourlyId}/run`, { method: 'POST' }), { params: Promise.resolve({ workflowId: w.hourlyId }) })).status).toBe(409);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await usageRows(w)).toEqual([]);
    expect(await liveHolds(w)).toEqual([]);
  });
});
