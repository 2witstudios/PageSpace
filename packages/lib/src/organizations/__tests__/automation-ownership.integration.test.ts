/**
 * [D-OW-36] An org's automations outlive their creator, against a real Postgres.
 *
 * Marcus, a member of Northwind, built automations in the org's Product drive: an hourly workflow, a
 * page webhook, a calendar trigger and a task trigger (the task and the calendar event are his too).
 * He also has a workflow in Jono's personal Side drive. When he leaves the org, or deletes his account,
 * the Product automations are disabled and flagged owner-left, never deleted, and none of them runs.
 * An Owner or Admin reassigns one to Lena (it then runs as her, bounded by her cap) or deletes it.
 *
 * REAL: leaveOrganization, removeMember, accountRepository.deleteUser, the reassign/delete services, the
 * credit gate and the caps, all on Postgres. Faked: the audit chain (captured) and ORGS_ENABLED (on).
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted, children first, users
 * last, and the pool is ended.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { walletCapAlerts, walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { leaveOrganization } from '../leave';
import { removeMember } from '../membership';
import { accountRepository } from '../../repositories/account-repository';
import {
  deleteOwnerLeftAutomation,
  listOwnerLeftAutomations,
  readWorkflowOwnership,
  reassignOwnerLeftAutomation,
} from '../automation-ownership';
import { automationRunOwner } from '../../permissions/automation-ownership';
import { canConsumeAI } from '../../billing/credit-gate';
import { consumeCredits } from '../../billing/credit-consume';
import { automationSpend } from '../../billing/spend-target';
import { setDriveWalletCap } from '../../services/drive-wallet-service';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  productId: string;
  sideId: string;
  jonoId: string;
  anaId: string;
  marcusId: string;
  lenaId: string;
  guestId: string;
  outsiderId: string;
  poolId: string;
  productWalletId: string;
  hourlyId: string;
  webhookId: string;
  calendarWorkflowId: string;
  calendarTriggerId: string;
  calendarEventId: string;
  taskWorkflowId: string;
  taskTriggerId: string;
  taskItemId: string;
  sideWorkflowId: string;
  userIds: string[];
}
let world: World | null = null;

async function build(): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'pro' });
  const ana = await factories.createUser({ name: 'Ana Admin', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const lena = await factories.createUser({ name: 'Lena Lead', subscriptionTier: 'free' });
  const guest = await factories.createUser({ name: 'Gita Guest', subscriptionTier: 'free' });
  const outsider = await factories.createUser({ name: 'Otto Outsider', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, stripeCustomerId: `cus_${createId()}` }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: ana.id, role: 'ADMIN' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  // An outsider invited onto Product: a drive member, but no seat in the org.
  await factories.createDriveMember(product.id, guest.id, { source: 'invite' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, monthlyRemainingCents: 50_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 10_000,
  }).returning();
  const side = await factories.createDrive(jono.id, { name: 'Side Project', slug: `side-${createId()}` });
  await factories.createDriveMember(side.id, marcus.id, { source: 'invite' });

  // Marcus's automations in Product.
  const [hourly] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, name: 'Hourly digest', prompt: 'summarize', cronExpression: '0 * * * *', nextRunAt: new Date(Date.now() + 3_600_000) }).returning();
  const channel = await factories.createPage(product.id, { title: 'alerts', type: 'CHANNEL' });
  const [webhook] = await db.insert(pageWebhooks).values({ pageId: channel.id, name: 'CI', webhookSecretEncrypted: 'enc', createdBy: marcus.id }).returning();
  const [calendarWorkflow] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, name: 'calendar-trigger', prompt: 'prep the standup', triggerType: 'event' }).returning();
  const [event] = await db.insert(calendarEvents).values({ driveId: product.id, createdById: marcus.id, title: 'Standup', startAt: new Date(Date.now() + 86_400_000), endAt: new Date(Date.now() + 90_000_000) }).returning();
  const [calendarTrigger] = await db.insert(calendarTriggers).values({ workflowId: calendarWorkflow.id, calendarEventId: event.id, driveId: product.id, scheduledById: marcus.id, triggerAt: new Date(Date.now() + 86_400_000) }).returning();
  const listPage = await factories.createPage(product.id, { title: 'Roadmap', type: 'TASK_LIST' });
  const [list] = await db.insert(taskLists).values({ userId: marcus.id, pageId: listPage.id, title: 'Roadmap' }).returning();
  const taskPage = await factories.createPage(product.id, { title: 'Ship it', type: 'TASK_LIST', parentId: listPage.id });
  const [task] = await db.insert(taskItems).values({ userId: marcus.id, pageId: taskPage.id, dueDate: new Date(Date.now() + 86_400_000) }).returning();
  void list;
  const [taskWorkflow] = await db.insert(workflows).values({ driveId: product.id, createdBy: marcus.id, name: 'task-trigger', prompt: 'nudge the assignee', triggerType: 'event' }).returning();
  const [taskTrigger] = await db.insert(taskTriggers).values({ workflowId: taskWorkflow.id, taskItemId: task.id, triggerType: 'due_date', nextRunAt: new Date(Date.now() + 86_400_000) }).returning();
  // And one in Jono's personal drive.
  const [sideWorkflow] = await db.insert(workflows).values({ driveId: side.id, createdBy: marcus.id, name: 'Side digest', prompt: 'summarize', cronExpression: '0 * * * *' }).returning();

  return {
    orgId: org.id, productId: product.id, sideId: side.id, jonoId: jono.id, anaId: ana.id, marcusId: marcus.id, lenaId: lena.id,
    guestId: guest.id, outsiderId: outsider.id, poolId: poolWallet.id, productWalletId: productWallet.id,
    hourlyId: hourly.id, webhookId: webhook.id, calendarWorkflowId: calendarWorkflow.id, calendarTriggerId: calendarTrigger.id,
    calendarEventId: event.id, taskWorkflowId: taskWorkflow.id, taskTriggerId: taskTrigger.id, taskItemId: task.id, sideWorkflowId: sideWorkflow.id,
    userIds: [jono.id, ana.id, marcus.id, lena.id, guest.id, outsider.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(walletCapAlerts).where(inArray(walletCapAlerts.walletId, [w.poolId, w.productWalletId]));
  await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [w.poolId, w.productWalletId]));
  await db.delete(workflows).where(inArray(workflows.driveId, [w.productId, w.sideId]));
  await db.delete(calendarEvents).where(inArray(calendarEvents.driveId, [w.productId, w.sideId]));
  await db.delete(taskLists).where(inArray(taskLists.pageId, db.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, [w.productId, w.sideId]))));
  await db.delete(wallets).where(eq(wallets.id, w.productWalletId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  // Pages, page webhooks, task items and drive members go with the drives.
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.sideId]));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const workflowRow = async (id: string) => (await db.select().from(workflows).where(eq(workflows.id, id)))[0] ?? null;
const webhookRow = async (id: string) => (await db.select().from(pageWebhooks).where(eq(pageWebhooks.id, id)))[0] ?? null;
/** What an executor asks before any hold: who the workflow runs as now, or why it must not run. */
const runOwner = async (workflowId: string) => {
  const ownership = await readWorkflowOwnership(workflowId);
  return ownership ? automationRunOwner(ownership) : null;
};
const gateAs = (userId: string, driveId: string) =>
  canConsumeAI(userId, 'free', { spend: automationSpend(driveId), estCostCents: 5, skipDailyCap: true });
const ownerLeftEvents = () => audit.events.filter((e) => e.eventType === 'org.automation.owner_left');

describe('[D-OW-36] an org drive\'s automations outlive their creator (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: workflows.id }).from(workflows).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('automation-ownership.integration.test.ts', error);
      dbAvailable = false;
    }
  });
  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    audit.events.length = 0;
  });
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });
  afterAll(async () => { await pool.end(); });

  it('SPEND-6 (partial) a creator who LEAVES the org: every automation they made in its drives is disabled and flagged owner-left, not deleted, and none runs', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    expect(await runOwner(w.hourlyId)).toEqual({ runs: true, ownerId: w.marcusId });

    const left = await leaveOrganization(w.marcusId, w.orgId);
    expect(left).toMatchObject({ ok: true });

    for (const id of [w.hourlyId, w.calendarWorkflowId, w.taskWorkflowId]) {
      const row = await workflowRow(id);
      expect(row).toMatchObject({ isEnabled: false, createdBy: w.marcusId });
      expect(row?.ownerLeftAt).toBeInstanceOf(Date);
      expect(await runOwner(id)).toMatchObject({ runs: false, reason: 'owner_left' });
    }
    expect(await webhookRow(w.webhookId)).toMatchObject({ isEnabled: false, createdBy: w.marcusId });
    expect((await webhookRow(w.webhookId))?.ownerLeftAt).toBeInstanceOf(Date);
    // The triggers hanging from the workflows are all still there.
    expect(await db.select().from(calendarTriggers).where(eq(calendarTriggers.id, w.calendarTriggerId))).toHaveLength(1);
    expect(await db.select().from(taskTriggers).where(eq(taskTriggers.id, w.taskTriggerId))).toHaveLength(1);
    // Leaving an org never reaches a personal drive's automation.
    expect(await workflowRow(w.sideWorkflowId)).toMatchObject({ isEnabled: true, ownerLeftAt: null, createdBy: w.marcusId });

    // An owner-left automation spends nothing: the executor stops at automationRunOwner, before any hold.
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).toEqual([]);

    expect(ownerLeftEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: w.orgId, actorId: w.marcusId, resourceType: 'workflow', resourceId: w.hourlyId, driveId: w.productId, details: { formerOwnerId: w.marcusId, reason: 'left_org' } }),
      expect.objectContaining({ resourceType: 'workflow', resourceId: w.calendarWorkflowId }),
      expect.objectContaining({ resourceType: 'workflow', resourceId: w.taskWorkflowId }),
      expect.objectContaining({ resourceType: 'page_webhook', resourceId: w.webhookId, driveId: w.productId }),
    ]));
    expect(ownerLeftEvents()).toHaveLength(4);
    expect((await listOwnerLeftAutomations(w.orgId)).map((a) => a.id).sort()).toEqual([w.hourlyId, w.calendarWorkflowId, w.taskWorkflowId, w.webhookId].sort());
  });

  it('SPEND-6 (partial) a member an Admin REMOVES is a departure too: their automations are flagged, and the Admin is the audit actor', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    expect((await removeMember({ orgId: w.orgId, actorId: w.anaId, targetId: w.marcusId })).ok).toBe(true);
    expect(await runOwner(w.hourlyId)).toMatchObject({ runs: false, reason: 'owner_left' });
    expect(ownerLeftEvents()).toHaveLength(4);
    for (const event of ownerLeftEvents()) expect(event).toMatchObject({ actorId: w.anaId, orgId: w.orgId });
  });

  it('SPEND-6 (partial) WAL-7 (partial) an Admin reassigns an owner-left workflow to an accepted member: it runs as her from then on, bounded by HER cap, and is audited', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await leaveOrganization(w.marcusId, w.orgId);
    await setDriveWalletCap(w.anaId, w.productId, w.lenaId, { dailyCents: 30, monthlyCents: null }, 'session');

    const nextRunAt = new Date(Date.now() + 1_800_000);
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId, nextRunAt: () => nextRunAt }))
      .toEqual({ ok: true });
    expect(await workflowRow(w.hourlyId)).toMatchObject({ createdBy: w.lenaId, ownerLeftAt: null, isEnabled: true, nextRunAt });
    expect(await runOwner(w.hourlyId)).toEqual({ runs: true, ownerId: w.lenaId });
    expect(audit.events).toContainEqual(expect.objectContaining({
      orgId: w.orgId, eventType: 'org.automation.reassigned', actorId: w.anaId, resourceType: 'workflow', resourceId: w.hourlyId, driveId: w.productId, details: { newOwnerId: w.lenaId },
    }));

    // The run is gated as Lena, on Product's wallet, until her cap is spent; Marcus is never charged.
    const owner = await runOwner(w.hourlyId);
    if (!owner?.runs) throw new Error('expected a runnable owner');
    const gate = await gateAs(owner.ownerId, w.productId);
    expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
    const [log] = await db.insert(aiUsageLogs).values({ userId: owner.ownerId, provider: 'openrouter', model: 'm', cost: 0.2 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: owner.ownerId, costDollars: 0.2, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled'); // 30¢
    expect(await gateAs(owner.ownerId, w.productId)).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { reason: 'source_cap_reached' } });
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, w.marcusId))).toEqual([]);

    // A reassigned calendar-trigger workflow is scheduled by its new owner too.
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.jonoId, kind: 'workflow', id: w.calendarWorkflowId, newOwnerId: w.lenaId })).toEqual({ ok: true });
    expect((await db.select().from(calendarTriggers).where(eq(calendarTriggers.id, w.calendarTriggerId)))[0]).toMatchObject({ scheduledById: w.lenaId });
    // And a page webhook is switched back on under its new owner.
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'page_webhook', id: w.webhookId, newOwnerId: w.lenaId })).toEqual({ ok: true });
    expect(await webhookRow(w.webhookId)).toMatchObject({ createdBy: w.lenaId, ownerLeftAt: null, isEnabled: true });
  });

  it('SPEND-6 (partial) reassigning is Owner/Admin only, to an accepted member who can reach the drive, and only for an owner-left automation; a refusal changes nothing', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    // Before anyone leaves, the workflow is its owner's: not this path's (409).
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId }))
      .toEqual({ ok: false, status: 409, reason: 'owner_present' });
    await leaveOrganization(w.marcusId, w.orgId);
    audit.events.length = 0;

    const attempt = (actorId: string, newOwnerId: string) =>
      reassignOwnerLeftAutomation({ orgId: w.orgId, actorId, kind: 'workflow', id: w.hourlyId, newOwnerId });
    expect(await attempt(w.lenaId, w.lenaId)).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(await attempt(w.outsiderId, w.lenaId)).toEqual({ ok: false, status: 404, reason: 'not_member' });
    // A guest of Product holds no seat in the org; the departed creator is no member either.
    expect(await attempt(w.anaId, w.guestId)).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    expect(await attempt(w.anaId, w.marcusId)).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    expect(await attempt(w.anaId, 'no-such-user')).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    // A workflow in a personal drive is not the org's.
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.sideWorkflowId, newOwnerId: w.lenaId }))
      .toEqual({ ok: false, status: 404, reason: 'not_found' });

    // Another org's Admin (review #2831 P3-2): through their own org the automation is not found; through
    // Northwind they are no member. A member of that other org is no owner for Northwind's automation, even
    // as an invited member of Product; nor is a pending invitee of Northwind who already holds a Product row.
    const [orgB] = await db.insert(organizations).values({ name: 'Contoso', slug: `contoso-${createId()}`, ownerId: w.outsiderId }).returning();
    try {
      await db.insert(orgMembers).values([
        { orgId: orgB.id, userId: w.outsiderId, role: 'ADMIN' },
        { orgId: orgB.id, userId: w.guestId, role: 'MEMBER' },
      ]);
      expect(await reassignOwnerLeftAutomation({ orgId: orgB.id, actorId: w.outsiderId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.outsiderId }))
        .toEqual({ ok: false, status: 404, reason: 'not_found' });
      expect(await deleteOwnerLeftAutomation({ orgId: orgB.id, actorId: w.outsiderId, kind: 'page_webhook', id: w.webhookId }))
        .toEqual({ ok: false, status: 404, reason: 'not_found' });
      expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.outsiderId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId }))
        .toEqual({ ok: false, status: 404, reason: 'not_member' });
      expect(await listOwnerLeftAutomations(orgB.id)).toEqual([]);
      expect(await attempt(w.anaId, w.guestId)).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, orgB.id));
    }
    const invitee = await factories.createUser({ name: 'Ivy Invitee' });
    w.userIds.push(invitee.id);
    await db.insert(orgInvitations).values({ orgId: w.orgId, email: invitee.email, tokenHash: createId(), invitedBy: w.anaId, expiresAt: new Date(Date.now() + 86_400_000) });
    await factories.createDriveMember(w.productId, invitee.id, { source: 'invite' });
    expect(await attempt(w.anaId, invitee.id)).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });

    expect(await workflowRow(w.hourlyId)).toMatchObject({ createdBy: w.marcusId, isEnabled: false });
    expect((await workflowRow(w.hourlyId))?.ownerLeftAt).toBeInstanceOf(Date);
    expect(audit.events.filter((e) => e.eventType === 'org.automation.reassigned')).toEqual([]);
  });

  it('SPEND-6 (partial) a reassignment racing the new owner\'s departure serializes with it: the departure commits first and the reassignment is refused, the automation staying off (review #2831 P2-2)', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await leaveOrganization(w.marcusId, w.orgId);

    // Lena's departure takes her org_members row and holds its transaction open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let leaveLocked!: () => void;
    const locked = new Promise<void>((resolve) => { leaveLocked = resolve; });
    const departure = db.transaction(async (tx) => {
      const left = await leaveOrganization(w.lenaId, w.orgId, tx);
      leaveLocked();
      await held;
      return left;
    });
    await locked;

    let settled = false;
    const reassign = reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId })
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // It waits on Lena's membership row: it cannot decide on a membership whose removal is in flight.
    expect(settled).toBe(false);

    release();
    expect(await departure).toMatchObject({ ok: true });
    expect(await reassign).toEqual({ ok: false, status: 400, reason: 'new_owner_not_member' });
    const row = await workflowRow(w.hourlyId);
    expect(row).toMatchObject({ createdBy: w.marcusId, isEnabled: false });
    expect(row?.ownerLeftAt).toBeInstanceOf(Date);
  });

  it('SPEND-6 (partial) a departure that starts after a reassignment committed flags the automation under its new owner (review #2831 P2-2)', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await leaveOrganization(w.marcusId, w.orgId);
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId })).toEqual({ ok: true });
    await leaveOrganization(w.lenaId, w.orgId);
    const row = await workflowRow(w.hourlyId);
    expect(row).toMatchObject({ createdBy: w.lenaId, isEnabled: false });
    expect(row?.ownerLeftAt).toBeInstanceOf(Date);
  });

  it('SPEND-6 (partial) an Admin deletes an owner-left automation (a workflow takes its triggers); a member cannot; both audited only when done', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await leaveOrganization(w.marcusId, w.orgId);
    expect(await deleteOwnerLeftAutomation({ orgId: w.orgId, actorId: w.lenaId, kind: 'page_webhook', id: w.webhookId }))
      .toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(await webhookRow(w.webhookId)).not.toBeNull();

    expect(await deleteOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'page_webhook', id: w.webhookId })).toEqual({ ok: true });
    expect(await webhookRow(w.webhookId)).toBeNull();
    expect(await deleteOwnerLeftAutomation({ orgId: w.orgId, actorId: w.jonoId, kind: 'workflow', id: w.calendarWorkflowId })).toEqual({ ok: true });
    expect(await workflowRow(w.calendarWorkflowId)).toBeNull();
    expect(await db.select().from(calendarTriggers).where(eq(calendarTriggers.id, w.calendarTriggerId))).toEqual([]);
    expect(audit.events.filter((e) => e.eventType === 'org.automation.deleted')).toEqual([
      expect.objectContaining({ orgId: w.orgId, actorId: w.anaId, resourceType: 'page_webhook', resourceId: w.webhookId, driveId: w.productId }),
      expect.objectContaining({ orgId: w.orgId, actorId: w.jonoId, resourceType: 'workflow', resourceId: w.calendarWorkflowId, driveId: w.productId }),
    ]);
  });

  it('SPEND-6 (partial) a creator who DELETES their account: the org automations survive disabled and owner-left with no trace of them, their triggers survive, none runs; a personal drive\'s goes with the account', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await accountRepository.deleteUser(w.marcusId);
    w.userIds = w.userIds.filter((id) => id !== w.marcusId);

    for (const id of [w.hourlyId, w.calendarWorkflowId, w.taskWorkflowId]) {
      const row = await workflowRow(id);
      expect(row).toMatchObject({ isEnabled: false, createdBy: null });
      expect(row?.ownerLeftAt).toBeInstanceOf(Date);
      expect(await runOwner(id)).toMatchObject({ runs: false, reason: 'owner_left' });
    }
    expect(await webhookRow(w.webhookId)).toMatchObject({ isEnabled: false, createdBy: null });
    // The calendar trigger and its event, the task trigger and its task all survive. The event and the
    // task Marcus created now name the drive's lead (Lena); the trigger names nobody.
    expect((await db.select().from(calendarTriggers).where(eq(calendarTriggers.id, w.calendarTriggerId)))[0]).toMatchObject({ scheduledById: null });
    expect((await db.select().from(calendarEvents).where(eq(calendarEvents.id, w.calendarEventId)))[0]).toMatchObject({ createdById: w.lenaId });
    expect((await db.select().from(taskItems).where(eq(taskItems.id, w.taskItemId)))[0]).toMatchObject({ userId: w.lenaId });
    expect(await db.select().from(taskTriggers).where(eq(taskTriggers.id, w.taskTriggerId))).toHaveLength(1);
    // The personal drive's workflow went with the account, as the creator cascade did before.
    expect(await workflowRow(w.sideWorkflowId)).toBeNull();

    // Nothing of Marcus is left on any automation row.
    const traces = [
      ...(await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.createdBy, w.marcusId))),
      ...(await db.select({ id: pageWebhooks.id }).from(pageWebhooks).where(eq(pageWebhooks.createdBy, w.marcusId))),
      ...(await db.select({ id: calendarTriggers.id }).from(calendarTriggers).where(eq(calendarTriggers.scheduledById, w.marcusId))),
    ];
    expect(traces).toEqual([]);
    expect(ownerLeftEvents()).toHaveLength(4);
    for (const event of ownerLeftEvents()) expect(event).toMatchObject({ orgId: w.orgId, details: { formerOwnerId: w.marcusId, reason: 'account_deleted' } });
    expect(ownerLeftEvents().some((e) => 'actorId' in e)).toBe(false);

    // An Admin reassigns one to Lena: it runs as her, under her cap.
    await setDriveWalletCap(w.anaId, w.productId, w.lenaId, { dailyCents: 30, monthlyCents: null }, 'session');
    expect(await reassignOwnerLeftAutomation({ orgId: w.orgId, actorId: w.anaId, kind: 'workflow', id: w.hourlyId, newOwnerId: w.lenaId })).toEqual({ ok: true });
    const owner = await runOwner(w.hourlyId);
    expect(owner).toEqual({ runs: true, ownerId: w.lenaId });
    const gate = await gateAs(w.lenaId, w.productId);
    expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.lenaId, provider: 'openrouter', model: 'm', cost: 0.2 }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: w.lenaId, costDollars: 0.2, holdId: gate.holdId, walletId: gate.walletId });
    expect(await gateAs(w.lenaId, w.productId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  it('SPEND-6 (partial) account deletion also flags an org drive automation whose creator was never an org member (an invited guest of the drive)', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    const [guestWorkflow] = await db.insert(workflows).values({ driveId: w.productId, createdBy: w.guestId, name: 'Guest digest', prompt: 'x', cronExpression: '0 * * * *' }).returning();
    await accountRepository.deleteUser(w.guestId);
    w.userIds = w.userIds.filter((id) => id !== w.guestId);
    expect(await workflowRow(guestWorkflow.id)).toMatchObject({ isEnabled: false, createdBy: null });
    expect(await runOwner(guestWorkflow.id)).toMatchObject({ runs: false, reason: 'owner_left' });
    // Marcus, who did not leave, is untouched.
    expect(await runOwner(w.hourlyId)).toEqual({ runs: true, ownerId: w.marcusId });
    expect(await db.select().from(workflows).where(and(eq(workflows.driveId, w.productId), eq(workflows.isEnabled, false)))).toHaveLength(1);
  });
});
