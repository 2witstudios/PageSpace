/**
 * The drive-wallet service against a real Postgres, per role (Spec SPEND-2, SPEND-3, SPEND-9,
 * SPEND-10, UI-9, UI-10, WAL-3, WAL-4): the REAL access model (drive relationships, org roles)
 * over a small Northwind Labs (Sequence Spec fixture).
 *
 *   Jono   org Owner        Priya  org Admin (not in Product)   Dana  member, Product's lead
 *   Marcus member of Product   Lena member of Product          Chris guest on Product
 *   Tomás  org member who has NOT joined Customer Research (Restricted)
 *   Outsider  not in the org, not on any drive
 *
 * The pool holds a distinctive balance and Lena a distinctive spend, so a consumer response
 * can be searched for either. Deletes every row it creates, children before parents, users
 * last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { workflows } from '@pagespace/db/schema/workflows';
import { consumeCredits } from '../../billing/credit-consume';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs, driveSpendOverrides, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { CONSUMER_WALLET_FIELDS } from '../../billing/wallet-views';
import { DEFAULT_SEAT_ALLOWANCE_CENTS, utcDayStartMs } from '../../billing/wallet-core';
import {
  getDriveWallet,
  createDriveWallet,
  updateDriveWallet,
  deleteDriveWallet,
  topUpDriveWallet,
  donateToDrive,
  listMyWallets,
  setPersonalDefaultSource,
  setAlwaysOwnCredits,
  getAlwaysOwnCredits,
  getConversationSpend,
  setConversationSpend,
  getOrgPoolSplit,
  listDriveWalletCaps,
  setDriveWalletCap,
  setSeatCap,
  listOrgSeatCaps,
  setOrgPoolPaused,
  getDriveSpend,
} from '../drive-wallet-service';
import { encodeAutomationRef } from '../../billing/automation-attribution';
import { formatCreditCount } from '../../billing/money-model';
import { credentialActor, automationActor, inDrives } from '../../permissions/access-actor';

const accountActor = (userId: string) => credentialActor(userId, { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' });

// Distinctive numbers, searched for in consumer responses.
const POOL_CENTS = 900_017;
const LENA_SPEND = 1_337;
const MARCUS_SPEND = 2_221;

interface World {
  orgId: string;
  productId: string;
  researchId: string;
  poolId: string;
  productWalletId: string;
  researchWalletId: string;
  ids: Record<'jono' | 'priya' | 'dana' | 'marcus' | 'lena' | 'chris' | 'tomas' | 'outsider', string>;
  userIds: string[];
}

let dbAvailable = false;
let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

async function build(): Promise<World> {
  const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free' });
  const [jono, priya, dana, marcus, lena, chris, tomas, outsider] = await Promise.all(
    ['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran', 'Lena Schulz', 'Chris Rowe', 'Tomás Alvarez', 'Outsider'].map(make),
  );
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  // Paid: there is no org trial, and an unpaid org is lapsed from creation (D-OW-30).
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: dana.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    { orgId: org.id, userId: tomas.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(dana.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, lena.id, { source: 'org' });
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  const research = await factories.createDrive(jono.id, { name: 'Customer Research', slug: `research-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });

  const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: POOL_CENTS }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id,
    monthlyAllowanceCents: 120_000, spentCents: LENA_SPEND + MARCUS_SPEND, monthlyPeriodStart: new Date(Date.now() - 86_400_000),
  }).returning();
  const [researchWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: research.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 60_000,
  }).returning();
  // Marcus's own credits, funded, so he can donate.
  await db.insert(wallets).values({ userId: marcus.id, monthlyRemainingCents: 5_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
  await db.insert(creditLedger).values([
    { userId: lena.id, walletId: productWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -LENA_SPEND, appliedCents: -LENA_SPEND, consumeStatus: 'applied' },
    { userId: marcus.id, walletId: productWallet.id, entryType: 'usage', bucket: 'monthly', amountCents: -MARCUS_SPEND, appliedCents: -MARCUS_SPEND, consumeStatus: 'applied' },
  ]);

  const ids = { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id, lena: lena.id, chris: chris.id, tomas: tomas.id, outsider: outsider.id };
  return {
    orgId: org.id,
    productId: product.id,
    researchId: research.id,
    poolId: poolWallet.id,
    productWalletId: productWallet.id,
    researchWalletId: researchWallet.id,
    ids,
    userIds: Object.values(ids),
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(driveSpendOverrides).where(inArray(driveSpendOverrides.userId, w.userIds));
  await db.delete(conversations).where(inArray(conversations.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  // Funding legs cascade with their wallet: deleting a leg first would leave its wallet's
  // top-up disagreeing with its legs, which the integration harness's invariant refuses.
  // Child wallets before their parent.
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];

describe('drive-wallet service (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('drive-wallet-service.integration.test.ts', error);
    }
  });

  beforeEach(async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    if (dbAvailable) world = await build();
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // What each role sees (SPEND-9, SPEND-10)
  // -------------------------------------------------------------------------

  it.each(['weak', 'expired'] as const)('SEC-2 (partial) SEC-3 (partial) Given a %s org credential, should withhold all org overview legs while keeping personal credits and admitting a current passkey', async kind => {
    if (!world) return;
    const userId = world.ids.priya;
    await db.insert(wallets).values({ userId, monthlyRemainingCents: 5000 });
    await updateDriveWallet(accountActor(userId), world.productId, { donationsEnabled: true }, 'session');
    expect(await donateToDrive(accountActor(userId), world.productId, { amountCents: 200, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
    const personalDrive = await factories.createDrive(userId);
    expect(await createDriveWallet(accountActor(userId), personalDrive.id, { allocationCents: 0 }, 'session')).toMatchObject({ ok: true });
    await updateDriveWallet(accountActor(userId), personalDrive.id, { donationsEnabled: true }, 'session');
    expect(await donateToDrive(accountActor(userId), personalDrive.id, { amountCents: 200, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
    await db.update(organizations).set({ policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 } }).where(eq(organizations.id, world.orgId));
    const refused = credentialActor(userId, { authenticatedAtMs: kind === 'expired' ? Date.now() - 3600000 : Date.now(), assurance: kind === 'weak' ? 'single_factor' : 'user_verified_passkey' });
    const hidden = await listMyWallets(refused, 'session');
    expect(hidden.personal.remainingCents).toBe(4600);
    expect({ seats: hidden.seats, pools: hidden.funds.pools }).toEqual({ seats: [], pools: [] });
    expect(hidden.driveWallets.map(wallet => wallet.driveId)).toEqual([personalDrive.id]);
    expect(hidden.funds.donations.map(donation => donation.driveId)).toEqual([personalDrive.id]);
    expect(JSON.stringify(hidden)).not.toContain(world.orgId);
    expect(JSON.stringify(hidden)).not.toContain(world.poolId);
    const allowed = await listMyWallets(accountActor(userId), 'session');
    expect(allowed.personal).toEqual(hidden.personal);
    expect(allowed.seats.map(seat => seat.orgId)).toEqual([world.orgId]);
    expect(allowed.funds.pools.map(pool => pool.orgId)).toEqual([world.orgId]);
    expect(allowed.funds.donations.map(donation => donation.driveId).sort()).toEqual([world.productId, personalDrive.id].sort());
    expect(allowed.funds.donations.find(donation => donation.driveId === personalDrive.id)).toEqual(hidden.funds.donations[0]);
  });

  it('a Home drive is never funded: a wallet made there earlier can be run down, but no one funds it and it is no source to spend from', async () => {
    if (!world) return;
    const userId = world.ids.priya;
    await db.insert(wallets).values({ userId, monthlyRemainingCents: 5000 });
    const home = await factories.createDrive(userId);
    // A wallet made before the rule: create it on a standard drive, then the drive is Home.
    expect(await createDriveWallet(accountActor(userId), home.id, { allocationCents: 0 }, 'session')).toMatchObject({ ok: true });
    await db.update(drives).set({ kind: 'HOME' }).where(eq(drives.id, home.id));

    const read = await getDriveWallet(accountActor(userId), home.id, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'lead', actions: ['view', 'view_spend_by_member', 'pause', 'set_rules', 'delete', 'set_caps'] });
    expect(await topUpDriveWallet(accountActor(userId), home.id, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 403 });
    expect(await donateToDrive(accountActor(userId), home.id, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 403 });

    const mine = await listMyWallets(accountActor(userId), 'session');
    expect(mine.driveWallets.map((w) => w.driveId)).not.toContain(home.id);
    expect(mine.funds.driveWallets.map((w) => w.driveId)).toContain(home.id);
  });

  it('SPEND-9 (partial) X-6 (partial) a MEMBER sees the remaining amount and their own cap only — never the pool balance or another consumer\'s spend', async () => {
    if (!world) return;
    const read = await getDriveWallet(credentialActor(world.ids.marcus, null), world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'member', actions: ['view', 'donate'] });
    if (!read.ok || !read.wallet) throw new Error('expected a wallet');
    expect(Object.keys(read.wallet).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
    expect(read.wallet).toMatchObject({ remainingCents: 120_000 - LENA_SPEND - MARCUS_SPEND });
    const json = JSON.stringify(read);
    expect(json).not.toContain(String(POOL_CENTS));
    expect(json).not.toContain(String(LENA_SPEND));
    expect(json).not.toContain(world.ids.lena);
    expect(json).not.toContain(world.poolId);
  });

  it('SPEND-9 (partial) a GUEST gets the same consumer projection', async () => {
    if (!world) return;
    const read = await getDriveWallet(credentialActor(world.ids.chris, null), world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'guest' });
    if (!read.ok || !read.wallet) throw new Error('expected a wallet');
    expect(Object.keys(read.wallet).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
    expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
  });

  it('SPEND-10 (partial) the drive LEAD sees spend by member for their drive, but never the pool', async () => {
    if (!world) return;
    const read = await getDriveWallet(credentialActor(world.ids.dana, null), world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'lead' });
    if (!read.ok || !read.wallet || read.wallet.viewer !== 'lead') throw new Error('expected a lead view');
    expect(read.wallet.spendByConsumer).toEqual([
      expect.objectContaining({ consumerKey: `user:${world.ids.marcus}`, userId: world.ids.marcus, displayName: 'Marcus Oyelaran', spentCents: MARCUS_SPEND, spentCredits: formatCreditCount(MARCUS_SPEND) }),
      expect.objectContaining({ consumerKey: `user:${world.ids.lena}`, userId: world.ids.lena, displayName: 'Lena Schulz', spentCents: LENA_SPEND, spentCredits: formatCreditCount(LENA_SPEND) }),
    ]);
    expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
    expect('pool' in read.wallet).toBe(false);
  });

  it("SPEND-10 the drive lead sees this period's spend by member, a creator's workflow spend inside their row as via automations and listed under it as the automation (D-OW-67); an org Owner/Admin also sees every org wallet, the pool and the unallocated balance", async () => {
    if (!world) return;
    const w = world;
    // Marcus's scheduled "Weekly digest" spends the drive wallet on his behalf (D-OW-34), and he makes a
    // call of his own; both settle for real on the Product wallet.
    const [digest] = await db.insert(workflows).values({ driveId: w.productId, createdBy: w.ids.marcus, name: 'Weekly digest', prompt: 'digest' }).returning();
    expect(await consumeCredits({ aiUsageLogId: createId(), userId: w.ids.marcus, costDollars: 0.04, walletId: w.productWalletId, automationRef: encodeAutomationRef({ kind: 'workflow', workflowId: digest.id }) })).toBe('settled');
    expect(await consumeCredits({ aiUsageLogId: createId(), userId: w.ids.marcus, costDollars: 0.02, walletId: w.productWalletId })).toBe('settled');
    const charged = async (automation: boolean) => -(await db.select({ applied: creditLedger.appliedCents, wf: creditLedger.automationRef }).from(creditLedger)
      .where(and(eq(creditLedger.walletId, w.productWalletId), eq(creditLedger.userId, w.ids.marcus), eq(creditLedger.entryType, 'usage'))))
      .filter((r) => (r.wf !== null) === automation)
      .reduce((sum, r) => sum + (r.applied ?? 0), 0);
    const digestCents = await charged(true);
    const marcusCents = await charged(false);
    expect(digestCents).toBeGreaterThan(0);

    const lead = await getDriveWallet(credentialActor(w.ids.dana, null), w.productId, 'session');
    if (!lead.ok || !lead.wallet || lead.wallet.viewer !== 'lead') throw new Error('expected a lead view');
    const rows = [...lead.wallet.spendByConsumer].sort((a, b) => a.displayName!.localeCompare(b.displayName!));
    expect(rows.map((r) => ({ label: r.displayName, cents: r.spentCents, via: r.viaAutomationsCents, automations: r.automations.map((a) => [a.displayName, a.spentCents]) }))).toEqual([
      { label: 'Lena Schulz', cents: LENA_SPEND, via: 0, automations: [] },
      { label: 'Marcus Oyelaran', cents: marcusCents + digestCents, via: digestCents, automations: [['Weekly digest', digestCents]] },
    ]);
    expect(rows[1].automations[0]).toMatchObject({ automation: { kind: 'workflow', workflowId: digest.id }, creatorUserId: w.ids.marcus, creatorName: 'Marcus Oyelaran' });

    // A consumer sees none of it (SPEND-9).
    const member = await getDriveWallet(credentialActor(w.ids.lena, null), w.productId, 'session');
    expect(JSON.stringify(member)).not.toContain('Weekly digest');

    // The org admin sees the same list, the pool and its unallocated balance, and every org wallet.
    const admin = await getDriveWallet(credentialActor(w.ids.priya, null), w.productId, 'session');
    if (!admin.ok || !admin.wallet || admin.wallet.viewer !== 'org_admin') throw new Error('expected an admin view');
    expect(admin.wallet.spendByConsumer).toEqual(lead.wallet.spendByConsumer);
    expect(admin.wallet.pool).toMatchObject({ walletId: w.poolId });
    expect(admin.wallet.pool!.unallocatedCents).toBe(admin.wallet.pool!.availableCents - ((120_000 - (await walletRow(w.productWalletId)).spentCents) + 60_000));
    const split = await getOrgPoolSplit(w.orgId);
    expect(split).toMatchObject({ walletId: w.poolId, availableCents: admin.wallet.pool!.availableCents, unallocatedCents: admin.wallet.pool!.unallocatedCents });
    expect(split.driveWallets.map((d) => d.walletId).sort()).toEqual([w.productWalletId, w.researchWalletId].sort());
  });

  it('UI-9 (partial) the lead sees who spends with today\'s part and the part automations spent on their behalf: the ledger\'s automation reference, never the usage log\'s source (D-OW-67)', async () => {
    if (!world) return;
    // The fixture's rows land "now": move them to just before today's UTC start, still inside the
    // period (which began a day ago), then add today's: one by hand, one by Marcus's workflow. The
    // hand call's usage log says "workflow" as its source: the list reads the ledger's reference only.
    await db.update(creditLedger).set({ createdAt: new Date(utcDayStartMs(Date.now()) - 1) }).where(eq(creditLedger.walletId, world.productWalletId));
    const [digest] = await db.insert(workflows).values({ driveId: world.productId, createdBy: world.ids.marcus, name: 'Weekly digest', prompt: 'digest' }).returning();
    const [handLog] = await db.insert(aiUsageLogs).values({ userId: world.ids.marcus, provider: 'openrouter', model: 'm', source: 'workflow' }).returning({ id: aiUsageLogs.id });
    await db.insert(creditLedger).values([
      { userId: world.ids.marcus, walletId: world.productWalletId, entryType: 'usage', bucket: 'monthly', amountCents: -70, appliedCents: -70, consumeStatus: 'applied', automationRef: encodeAutomationRef({ kind: 'workflow', workflowId: digest.id }) },
      { userId: world.ids.marcus, walletId: world.productWalletId, entryType: 'usage', bucket: 'monthly', amountCents: -11, appliedCents: -11, consumeStatus: 'applied', aiUsageLogId: handLog.id },
    ]);
    const read = await getDriveWallet(credentialActor(world.ids.dana, null), world.productId, 'session');
    if (!read.ok || !read.wallet || read.wallet.viewer !== 'lead') throw new Error('expected a lead view');
    const marcus = read.wallet.spendByConsumer.find((c) => c.userId === world?.ids.marcus);
    expect(marcus).toMatchObject({ spentCents: MARCUS_SPEND + 81, spentTodayCents: 81, viaAutomationsCents: 70, spentTodayCredits: formatCreditCount(81), viaAutomationsCredits: formatCreditCount(70) });
    expect(marcus?.automations.map((a) => [a.displayName, a.spentCents, a.spentTodayCents])).toEqual([['Weekly digest', 70, 70]]);
    expect(read.wallet.spendByConsumer.find((c) => c.userId === world?.ids.lena)).toMatchObject({ spentCents: LENA_SPEND, spentTodayCents: 0, viaAutomationsCents: 0, automations: [] });

    // A consumer never sees any of it (SPEND-9).
    const member = await getDriveWallet(credentialActor(world.ids.marcus, null), world.productId, 'session');
    expect(JSON.stringify(member)).not.toMatch(/spendByConsumer|viaAutomations|spentToday|Weekly digest/);
  });

  it('SPEND-10 (partial) an ORG ADMIN sees every wallet field, the pool and the unallocated balance', async () => {
    if (!world) return;
    const read = await getDriveWallet(credentialActor(world.ids.priya, null), world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'org_admin' });
    if (!read.ok || !read.wallet || read.wallet.viewer !== 'org_admin') throw new Error('expected an admin view');
    const outstanding = (120_000 - LENA_SPEND - MARCUS_SPEND) + 60_000;
    expect(read.wallet.pool).toEqual({
      walletId: world.poolId,
      availableCents: POOL_CENTS,
      unallocatedCents: POOL_CENTS - outstanding,
      availableCredits: formatCreditCount(POOL_CENTS),
      unallocatedCredits: formatCreditCount(POOL_CENTS - outstanding),
    });
  });

  it('SPEND-9 (partial) X-6 (partial) a NON-MEMBER gets 404: an outsider on Product, an org member who has not joined a Restricted drive', async () => {
    if (!world) return;
    expect(await getDriveWallet(credentialActor(world.ids.outsider, null), world.productId, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await getDriveWallet(credentialActor(world.ids.tomas, null), world.researchId, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await donateToDrive(credentialActor(world.ids.tomas, null), world.researchId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 404 });
  });

  // -------------------------------------------------------------------------
  // What each role may change (UI-9)
  // -------------------------------------------------------------------------

  it('UI-9 (partial) a member and a guest cannot change the wallet; the lead can pause and set rules but not move pool money', async () => {
    if (!world) return;
    for (const who of [world.ids.marcus, world.ids.chris]) {
      expect(await updateDriveWallet(credentialActor(who, null), world.productId, { paused: true }, 'session')).toMatchObject({ ok: false, status: 403 });
      expect(await updateDriveWallet(credentialActor(who, null), world.productId, { allocationCents: 1 }, 'session')).toMatchObject({ ok: false, status: 403 });
    }
    expect(await updateDriveWallet(credentialActor(world.ids.dana, null), world.productId, { allocationCents: 999_999 }, 'session')).toMatchObject({ ok: false, status: 403, code: 'insufficient_role' });
    // A mixed change is refused whole: nothing from it lands.
    expect(await updateDriveWallet(credentialActor(world.ids.dana, null), world.productId, { paused: true, allocationCents: 1 }, 'session')).toMatchObject({ ok: false, status: 403 });
    expect((await walletRow(world.productWalletId)).status).toBe('active');

    const paused = await updateDriveWallet(credentialActor(world.ids.dana, null), world.productId, { paused: true, donationsEnabled: false, fallbackRule: 'own_credits', defaultSpendSource: 'drive_wallet' }, 'session');
    expect(paused).toMatchObject({ ok: true, wallet: { status: 'paused', donationsEnabled: false, fallbackRule: 'own_credits', defaultSpendSource: 'drive_wallet' } });
    expect(await topUpDriveWallet(credentialActor(world.ids.dana, null), world.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 403 });
  });

  it('WAL-6 (partial) where an org drive\'s overshoot lands is the FUNDER\'s choice: the lead cannot set it, an org admin can, and null restores the default', async () => {
    if (!world) return;
    expect(await updateDriveWallet(credentialActor(world.ids.dana, null), world.productId, { overshootChoice: 'wallet_debt' }, 'session')).toMatchObject({ ok: false, status: 403, code: 'insufficient_role' });
    expect((await walletRow(world.productWalletId)).overshootChoice).toBeNull();

    expect(await updateDriveWallet(credentialActor(world.ids.priya, null), world.productId, { overshootChoice: 'wallet_debt' }, 'session')).toMatchObject({ ok: true, wallet: { overshootChoice: 'wallet_debt' } });
    expect((await walletRow(world.productWalletId)).overshootChoice).toBe('wallet_debt');
    // A token may never move the funder's money decisions.
    expect(await updateDriveWallet(credentialActor(world.ids.priya, null), world.productId, { overshootChoice: null }, 'mcp')).toMatchObject({ ok: false, status: 403 });

    expect(await updateDriveWallet(credentialActor(world.ids.priya, null), world.productId, { overshootChoice: null }, 'session')).toMatchObject({ ok: true, wallet: { overshootChoice: null } });
    expect((await walletRow(world.productWalletId)).overshootChoice).toBeNull();
  });

  it('UI-9 (partial) WAL-3 (partial) an org admin allocates and tops up from the pool; the top-up is an owner leg and a ledger pair', async () => {
    if (!world) return;
    expect(await updateDriveWallet(credentialActor(world.ids.priya, null), world.productId, { allocationCents: 150_000 }, 'session')).toMatchObject({ ok: true, wallet: { allocationCents: 150_000 } });
    const key = createId();
    const topUp = await topUpDriveWallet(credentialActor(world.ids.priya, null), world.productId, { amountCents: 10_000, idempotencyKey: key }, 'session');
    expect(topUp).toMatchObject({ ok: true, amountCents: 10_000, duplicate: false });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 10_000);
    expect((await walletRow(world.productWalletId)).topupRemainingCents).toBe(10_000);
    const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, world.productWalletId));
    expect(legs.map((l) => [l.funderKind, l.funderOrgId, l.originalCents, l.nonRefundable])).toEqual([['owner', world.orgId, 10_000, false]]);
    // Replaying the same key moves nothing.
    expect(await topUpDriveWallet(credentialActor(world.ids.priya, null), world.productId, { amountCents: 10_000, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, duplicate: true });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 10_000);
  });

  it('WAL-3 (partial) a top-up the pool cannot cover is refused whole and moves nothing', async () => {
    if (!world) return;
    expect(await topUpDriveWallet(credentialActor(world.ids.priya, null), world.productId, { amountCents: POOL_CENTS + 1, idempotencyKey: createId() }, 'session'))
      .toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS);
  });

  it('WAL-4 (partial) a member donates from their own balance; the lead can turn donations off', async () => {
    if (!world) return;
    expect(await donateToDrive(credentialActor(world.ids.marcus, null), world.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, amountCents: 1_000 });
    await updateDriveWallet(credentialActor(world.ids.dana, null), world.productId, { donationsEnabled: false }, 'session');
    expect(await donateToDrive(credentialActor(world.ids.marcus, null), world.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'donations_disabled' });
  });

  it('UI-9 (partial) a wallet that moved money is refused deletion with its blockers; an unused one deletes', async () => {
    if (!world) return;
    expect(await deleteDriveWallet(credentialActor(world.ids.priya, null), world.productId, 'session')).toMatchObject({ ok: false, status: 409, blockers: ['has_money_history'] });
    expect(await deleteDriveWallet(credentialActor(world.ids.dana, null), world.productId, 'session')).toMatchObject({ ok: false, status: 403 });
    expect(await deleteDriveWallet(credentialActor(world.ids.jono, null), world.researchId, 'session')).toEqual({ ok: true });
    expect(await getDriveWallet(credentialActor(world.ids.jono, null), world.researchId, 'session')).toMatchObject({ ok: true, wallet: null });
    // An org admin re-creates it under the pool.
    expect(await createDriveWallet(credentialActor(world.ids.priya, null), world.researchId, { allocationCents: 5_000 }, 'session')).toMatchObject({ ok: true, wallet: { allocationCents: 5_000 } });
    expect(await createDriveWallet(credentialActor(world.ids.priya, null), world.researchId, { allocationCents: 5_000 }, 'session')).toMatchObject({ ok: false, status: 409, code: 'wallet_exists' });
    const [row] = await db.select().from(wallets).where(eq(wallets.subjectId, world.researchId));
    expect([row.ownerType, row.orgId, row.parentWalletId]).toEqual(['org', world.orgId, world.poolId]);
  });

  // -------------------------------------------------------------------------
  // Settings › Usage › Wallets (UI-10) and the per-conversation source (SPEND-2, SPEND-3)
  // -------------------------------------------------------------------------

  it('UI-10 (partial) SPEND-9 (partial) a member lists what they spend from (drive wallets, their seat) with no pool balance; an admin also lists the pool they fund', async () => {
    if (!world) return;
    const marcus = await listMyWallets(credentialActor(world.ids.marcus, null), 'session');
    expect(marcus.driveWallets).toEqual([{
      driveId: world.productId, driveName: 'Product', walletId: world.productWalletId, status: 'active',
      remainingCents: 120_000 - LENA_SPEND - MARCUS_SPEND, remainingCredits: formatCreditCount(120_000 - LENA_SPEND - MARCUS_SPEND),
      mySpentCents: MARCUS_SPEND, mySpentCredits: formatCreditCount(MARCUS_SPEND),
    }]);
    // His own spend only: Lena's never appears in his list (SPEND-9).
    expect(JSON.stringify(marcus.driveWallets)).not.toContain(String(LENA_SPEND));
    expect(marcus.seats).toEqual([expect.objectContaining({ orgId: world.orgId, orgName: 'Northwind Labs', walletId: world.poolId })]);
    expect(marcus.funds.pools).toEqual([]);
    expect(JSON.stringify(marcus)).not.toContain(String(POOL_CENTS));

    const priya = await listMyWallets(credentialActor(world.ids.priya, null), 'session');
    expect(priya.funds.pools).toEqual([expect.objectContaining({ orgId: world.orgId, orgName: 'Northwind Labs', walletId: world.poolId, availableCents: POOL_CENTS, availableCredits: formatCreditCount(POOL_CENTS) })]);
    expect(JSON.stringify([marcus, priya])).not.toContain('$');
  });

  it('UI-10 (partial) SPEND-9 (partial) a member\'s seat shows their own allowance, what they spent of it and what is left, never the pool (D-OW-38 read model)', async () => {
    if (!world) return;
    await db.insert(creditLedger).values({
      userId: world.ids.marcus, walletId: world.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -30, appliedCents: -30, chargeMillicents: 30_000, consumeStatus: 'applied',
    });
    const [seat] = (await listMyWallets(credentialActor(world.ids.marcus, null), 'session')).seats;
    expect(seat).toEqual({
      orgId: world.orgId,
      orgName: 'Northwind Labs',
      walletId: world.poolId,
      allowanceCents: DEFAULT_SEAT_ALLOWANCE_CENTS,
      allowanceCredits: formatCreditCount(DEFAULT_SEAT_ALLOWANCE_CENTS),
      spentCents: 30,
      spentCredits: formatCreditCount(30),
      remainingCents: DEFAULT_SEAT_ALLOWANCE_CENTS - 30,
      remainingCredits: formatCreditCount(DEFAULT_SEAT_ALLOWANCE_CENTS - 30),
    });
    // The same figure the spending-from popover shows for the seat: one source (seatAllowanceFor).
    const conversationId = createId();
    await db.insert(conversations).values({ id: conversationId, userId: world.ids.marcus, type: 'drive', contextId: world.productId, updatedAt: new Date() });
    const read = await getConversationSpend(accountActor(world.ids.marcus), conversationId);
    if (!read.ok) throw new Error('conversation read refused');
    expect(read.options.find((o) => o.source === 'seat_allowance')?.remainingCents).toBe(seat.remainingCents);
    expect(JSON.stringify(seat)).not.toContain(String(POOL_CENTS));
  });

  it('SPEND-3 (partial) UI-10 (partial) the person sets and clears their own default source', async () => {
    if (!world) return;
    expect(await setPersonalDefaultSource(world.ids.marcus, 'seat_allowance', 'session')).toEqual({ ok: true, defaultSpendSource: 'seat_allowance' });
    expect((await listMyWallets(credentialActor(world.ids.marcus, null), 'session')).personal.defaultSpendSource).toBe('seat_allowance');
    await setPersonalDefaultSource(world.ids.marcus, null, 'session');
    expect((await listMyWallets(credentialActor(world.ids.marcus, null), 'session')).personal.defaultSpendSource).toBeNull();
  });

  it('SPEND-5 (partial) the person turns "Always my own credits" on and off, globally and for one drive, and reads it back', async () => {
    if (!world) return;
    const w = world;
    expect(await getAlwaysOwnCredits(w.ids.marcus, w.productId)).toEqual({ ok: true, alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false });

    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: null, enabled: true }, 'session')).toEqual({ ok: true, driveId: null, enabled: true });
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: w.productId, enabled: true }, 'session')).toEqual({ ok: true, driveId: w.productId, enabled: true });
    // Idempotent: turning an on switch on again changes nothing.
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: w.productId, enabled: true }, 'session')).toMatchObject({ ok: true });
    expect(await getAlwaysOwnCredits(w.ids.marcus, w.productId)).toEqual({ ok: true, alwaysOwnCredits: true, alwaysOwnCreditsInDrive: true });
    expect((await db.select().from(wallets).where(personalRootWalletOf(w.ids.marcus)))[0]).toMatchObject({ alwaysOwnCredits: true });

    await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: null, enabled: false }, 'session');
    await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: w.productId, enabled: false }, 'session');
    expect(await getAlwaysOwnCredits(w.ids.marcus, w.productId)).toEqual({ ok: true, alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false });
    expect(await db.select().from(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.ids.marcus))).toEqual([]);
  });

  it('SPEND-5 (partial) a per-drive switch can be set only for a drive the person can open; a token cannot set either switch ([D-OW-26])', async () => {
    if (!world) return;
    const w = world;
    // Customer Research is Restricted and Marcus has not joined it.
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: w.researchId, enabled: true }, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: `drive_${createId()}`, enabled: true }, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: null, enabled: true }, 'mcp')).toMatchObject({ ok: false, status: 403, code: 'mcp_token_cannot_change_spend_source' });
    expect(await setAlwaysOwnCredits(credentialActor(w.ids.marcus, null), { driveId: w.productId, enabled: true }, 'mcp')).toMatchObject({ ok: false, status: 403, code: 'mcp_token_cannot_change_spend_source' });
    expect(await db.select().from(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.ids.marcus))).toEqual([]);
    expect((await db.select().from(wallets).where(personalRootWalletOf(w.ids.marcus)))[0]?.alwaysOwnCredits ?? false).toBe(false);
  });

  it('SPEND-2 (partial) SPEND-3 (partial) a conversation\'s source is chosen explicitly, persists, and the preview shows what the gate would spend', async () => {
    if (!world) return;
    const [conv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();

    const before = await getConversationSpend(accountActor(world.ids.marcus), conv.id);
    // Nothing chosen and no default set: the preview shows the out-of-box drive wallet, as the gate would spend.
    expect(before).toMatchObject({ ok: true, chosenWalletId: null, resolved: { kind: 'spend', source: 'drive_wallet', walletId: world.productWalletId } });
    if (!before.ok) throw new Error('expected a read');
    expect(before.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    // UI-8: each choice is named and says what this person can still spend from it, as a credit count.
    expect(before.options.map((o) => [o.label, o.driveName, o.orgName, typeof o.remainingCents, o.remainingCredits === formatCreditCount(Number(o.remainingCents))])).toEqual([
      ['Product wallet', 'Product', 'Northwind Labs', 'number', true],
      ['Northwind Labs seat', 'Product', 'Northwind Labs', 'number', true],
      ['Your credits', null, null, 'number', true],
    ]);
    // The seat shows the member's own remaining allowance, never the pool's balance (SPEND-9).
    expect(before.options[1].remainingCents).toBeLessThan(POOL_CENTS);

    const chosen = await setConversationSpend(accountActor(world.ids.marcus), conv.id, world.poolId, 'session');
    expect(chosen).toMatchObject({ ok: true, chosenWalletId: world.poolId, resolved: { kind: 'spend', source: 'seat_allowance', walletId: world.poolId } });
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].chosenWalletId).toBe(world.poolId);

    expect(await setConversationSpend(accountActor(world.ids.marcus), conv.id, null, 'session')).toMatchObject({ ok: true, chosenWalletId: null });
  });

  it('SPEND-3 (partial) X-6 (partial) a conversation cannot store a wallet the person may not spend: another person\'s, a Restricted drive\'s they have not joined, the pool for a guest', async () => {
    if (!world) return;
    const [conv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    const [lenaWallet] = await db.insert(wallets).values({ userId: world.ids.lena }).returning();
    for (const walletId of [lenaWallet.id, world.researchWalletId, 'w-does-not-exist']) {
      expect(await setConversationSpend(accountActor(world.ids.marcus), conv.id, walletId, 'session'), walletId).toMatchObject({ ok: false, status: 400, code: 'wallet_not_available' });
    }
    const [chrisConv] = await db.insert(conversations).values({ userId: world.ids.chris, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    for (const walletId of [world.poolId, world.productWalletId]) {
      expect(await setConversationSpend(accountActor(world.ids.chris), chrisConv.id, walletId, 'session'), walletId).toMatchObject({ ok: false, status: 400 });
    }
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].chosenWalletId).toBeNull();
  });

  it('SPEND-3 (partial) a person cannot read or change the source of someone else\'s conversation', async () => {
    if (!world) return;
    const [lenasConv] = await db.insert(conversations).values({ userId: world.ids.lena, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    expect(await getConversationSpend(accountActor(world.ids.marcus), lenasConv.id)).toMatchObject({ ok: false, status: 404 });
    expect(await setConversationSpend(accountActor(world.ids.marcus), lenasConv.id, null, 'session')).toMatchObject({ ok: false, status: 404 });
  });
  it('SPEND-7 (partial) SPEND-3 (partial) a page conversation\'s options come from its page\'s drive; a global one offers own credits unless a drive is named, and a drive the person cannot open is refused', async () => {
    if (!world) return;
    const page = await factories.createPage(world.productId, { title: 'Roadmap', type: 'AI_CHAT' });
    const [pageConv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'page', contextId: page.id, updatedAt: new Date() }).returning();
    const onPage = await getConversationSpend(accountActor(world.ids.marcus), pageConv.id);
    expect(onPage.ok && onPage.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);

    const [globalConv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'global', updatedAt: new Date() }).returning();
    const alone = await getConversationSpend(accountActor(world.ids.marcus), globalConv.id);
    expect(alone.ok && alone.options.map((o) => o.source)).toEqual(['own_credits']);
    const inProduct = await getConversationSpend(accountActor(world.ids.marcus), globalConv.id, world.productId);
    expect(inProduct.ok && inProduct.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    const inResearch = await getConversationSpend(accountActor(world.ids.marcus), globalConv.id, world.researchId);
    expect(inResearch).toMatchObject({ ok: false, status: 404 });
    expect(await setConversationSpend(accountActor(world.ids.marcus), globalConv.id, world.researchWalletId, 'session', world.researchId)).toMatchObject({ ok: false, status: 404 });
  });
  it('SPEND-2 (partial) inside a drive with no conversation the chip reads the drive: its options and what a new conversation would spend, with nothing stored; one source for a person with no shared leg; a drive they cannot open is 404', async () => {
    if (!world) return;
    const convBefore = await db.select().from(conversations).where(eq(conversations.userId, world.ids.marcus));
    const read = await getDriveSpend(credentialActor(world.ids.marcus, null), world.productId);
    expect(read).toMatchObject({ ok: true, driveId: world.productId, resolved: { kind: 'spend', source: 'drive_wallet', walletId: world.productWalletId } });
    expect(read.ok && read.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    // A read: no conversation is created or pinned, and nothing is reserved.
    expect(await db.select().from(conversations).where(eq(conversations.userId, world.ids.marcus))).toEqual(convBefore);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, world.ids.marcus))).toEqual([]);
    // Chris is a guest of Product (no seat, no drive wallet by default): one source, so the personal chip stays.
    const guest = await getDriveSpend(credentialActor(world.ids.chris, null), world.productId);
    expect(guest.ok && guest.options.map((o) => o.source)).toEqual(['own_credits']);
    // Marcus has not joined the Restricted drive; the outsider cannot open Product.
    expect(await getDriveSpend(credentialActor(world.ids.marcus, null), world.researchId)).toMatchObject({ ok: false, status: 404 });
    expect(await getDriveSpend(credentialActor(world.ids.outsider, null), world.productId)).toMatchObject({ ok: false, status: 404 });
  });

  // -------------------------------------------------------------------------
  // [D-OW-26] a delegated MCP/CLI token never moves money or redirects spend
  // -------------------------------------------------------------------------

  /** Every row a wallet write could touch, for the fixture's org and people. */
  async function moneySnapshot(w: World): Promise<string> {
    const walletRows = await db.select().from(wallets).where(inArray(wallets.id, [w.poolId, w.productWalletId, w.researchWalletId]));
    const personal = await db.select().from(wallets).where(inArray(wallets.userId, w.userIds));
    const ledger = await db.select().from(creditLedger).where(inArray(creditLedger.userId, w.userIds));
    const legs = await db.select().from(walletFundingLegs).where(inArray(walletFundingLegs.walletId, [w.poolId, w.productWalletId, w.researchWalletId]));
    const convs = await db.select().from(conversations).where(inArray(conversations.userId, w.userIds));
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ walletRows: byId(walletRows), personal: byId(personal), ledger: byId(ledger), legs: byId(legs), convs: byId(convs) });
  }

  it('X-1 (partial) SPEND-3 (partial) [D-OW-26] every wallet write with an MCP token is refused by name and writes NOTHING; the same write in a session lands', async () => {
    if (!world) return;
    const w = world;
    const [conv] = await db.insert(conversations).values({ userId: w.ids.marcus, type: 'drive', contextId: w.productId, updatedAt: new Date() }).returning();
    const key = createId();
    // Priya is an org admin: every one of these would be allowed to her in a session.
    const writes: [string, () => Promise<unknown>, string][] = [
      ['create', () => createDriveWallet(credentialActor(w.ids.priya, null), w.researchId, { allocationCents: 1 }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['allocate', () => updateDriveWallet(credentialActor(w.ids.priya, null), w.productId, { allocationCents: 1 }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['pause', () => updateDriveWallet(credentialActor(w.ids.priya, null), w.productId, { paused: true }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['rules', () => updateDriveWallet(credentialActor(w.ids.priya, null), w.productId, { donationsEnabled: false }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['top-up', () => topUpDriveWallet(credentialActor(w.ids.priya, null), w.productId, { amountCents: 1_000, idempotencyKey: key }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['donate', () => donateToDrive(credentialActor(w.ids.marcus, null), w.productId, { amountCents: 1_000, idempotencyKey: key }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['delete', () => deleteDriveWallet(credentialActor(w.ids.jono, null), w.researchId, 'mcp'), 'mcp_token_cannot_move_money'],
      ['conversation source', () => setConversationSpend(accountActor(w.ids.marcus), conv.id, w.poolId, 'mcp'), 'mcp_token_cannot_change_spend_source'],
      ['default source', () => setPersonalDefaultSource(w.ids.marcus, 'own_credits', 'mcp'), 'mcp_token_cannot_change_spend_source'],
    ];
    const before = await moneySnapshot(w);
    for (const [name, write, code] of writes) {
      expect(await write(), name).toMatchObject({ ok: false, status: 403, code });
    }
    expect(await moneySnapshot(w)).toBe(before);

    // The session path still works for each.
    expect(await updateDriveWallet(credentialActor(w.ids.priya, null), w.productId, { allocationCents: 130_000, paused: true, donationsEnabled: false }, 'session')).toMatchObject({ ok: true });
    await updateDriveWallet(credentialActor(w.ids.priya, null), w.productId, { paused: false, donationsEnabled: true }, 'session');
    expect(await topUpDriveWallet(credentialActor(w.ids.priya, null), w.productId, { amountCents: 1_000, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, duplicate: false });
    expect(await donateToDrive(credentialActor(w.ids.marcus, null), w.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
    expect(await deleteDriveWallet(credentialActor(w.ids.jono, null), w.researchId, 'session')).toEqual({ ok: true });
    expect(await createDriveWallet(credentialActor(w.ids.priya, null), w.researchId, { allocationCents: 1 }, 'session')).toMatchObject({ ok: true });
    expect(await setConversationSpend(accountActor(w.ids.marcus), conv.id, w.poolId, 'session')).toMatchObject({ ok: true, chosenWalletId: w.poolId });
    expect(await setPersonalDefaultSource(w.ids.marcus, 'own_credits', 'session')).toEqual({ ok: true, defaultSpendSource: 'own_credits' });
    expect(await moneySnapshot(w)).not.toBe(before);
  });

  it('SPEND-9 (partial) [D-OW-26] read with a token, an org admin and a lead get exactly the consumer projection and no actions but view; my wallets drops pool balances', async () => {
    if (!world) return;
    for (const who of [world.ids.priya, world.ids.dana]) {
      const read = await getDriveWallet(credentialActor(who, null), world.productId, 'mcp');
      expect(read).toMatchObject({ ok: true, viewer: 'member', actions: ['view'] });
      if (!read.ok || !read.wallet) throw new Error('expected a wallet');
      expect(Object.keys(read.wallet).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
      expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
      expect(JSON.stringify(read)).not.toContain(world.ids.lena);
    }
    const priya = await listMyWallets(credentialActor(world.ids.priya, null), 'mcp');
    expect(priya.funds.pools).toEqual([]);
    expect(JSON.stringify(priya)).not.toContain(String(POOL_CENTS));
  });
  it('WAL-3 (partial) a personal drive\'s lead cannot top up past what their own wallet can spare: holds on the drive wallet (its child) count against it', async () => {
    if (!world) return;
    // Dana's personal drive, funded by her personal root (1,000 cents); a turn in the drive holds 600 on its wallet.
    const notes = await factories.createDrive(world.ids.dana, { name: 'Dana notes', slug: `notes-${createId()}` });
    const [root] = await db.insert(wallets).values({ userId: world.ids.dana, monthlyRemainingCents: 1_000 }).returning();
    const [child] = await db.insert(wallets).values({
      ownerType: 'user', userId: world.ids.dana, subjectType: 'drive', subjectId: notes.id, parentWalletId: root.id, monthlyAllowanceCents: 5_000,
    }).returning();
    await db.insert(creditHolds).values({ userId: world.ids.dana, walletId: child.id, estCents: 600, expiresAt: new Date(Date.now() + 60_000) });
    try {
      expect(await topUpDriveWallet(credentialActor(world.ids.dana, null), notes.id, { amountCents: 500, idempotencyKey: createId() }, 'session'))
        .toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
      expect((await walletRow(root.id)).monthlyRemainingCents).toBe(1_000);
      expect(await topUpDriveWallet(credentialActor(world.ids.dana, null), notes.id, { amountCents: 400, idempotencyKey: createId() }, 'session'))
        .toMatchObject({ ok: true, amountCents: 400 });
    } finally {
      await db.delete(creditHolds).where(eq(creditHolds.walletId, child.id));
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, [child.id, root.id]));
      await db.delete(wallets).where(eq(wallets.id, child.id));
      await db.delete(drives).where(eq(drives.id, notes.id));
    }
  });
  it('WAL-3 (partial) a top-up and a donation into the same drive wallet from the same root never deadlock: both lock the drive wallet, then its parent (the global order)', async () => {
    if (!world) return;
    // Dana's personal drive; ids chosen so her root sorts BEFORE the drive wallet, so an
    // id-sorted lock order would take the parent first — the inversion of the global order.
    const notes = await factories.createDrive(world.ids.dana, { name: 'Dana notes', slug: `notes-${createId()}` });
    const [root] = await db.insert(wallets).values({ id: `a${createId()}`, userId: world.ids.dana, monthlyRemainingCents: 5_000 }).returning();
    const [child] = await db.insert(wallets).values({
      id: `z${createId()}`, ownerType: 'user', userId: world.ids.dana, subjectType: 'drive', subjectId: notes.id, parentWalletId: root.id, monthlyAllowanceCents: 1_000,
    }).returning();
    try {
      // Hold the drive wallet so both writers queue behind it: Dana donating to her own drive
      // first (it locks the drive wallet, then her root), then the top-up. A top-up that took
      // her root first would hold it while waiting on the drive wallet the donation gets next —
      // a cycle Postgres breaks by aborting one of them (40P01).
      let release!: () => void;
      let markLocked!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const blocker = db.transaction(async (tx) => {
        await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, child.id)).for('no key update');
        markLocked();
        await released;
      });
      await locked;
      const donation = donateToDrive(credentialActor(world.ids.dana, null), notes.id, { amountCents: 200, idempotencyKey: createId() }, 'session');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const topUp = topUpDriveWallet(credentialActor(world.ids.dana, null), notes.id, { amountCents: 300, idempotencyKey: createId() }, 'session');
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await blocker;

      const [toppedUp, donated] = await Promise.allSettled([topUp, donation]);
      expect(toppedUp).toMatchObject({ status: 'fulfilled', value: { ok: true, amountCents: 300 } });
      expect(donated).toMatchObject({ status: 'fulfilled', value: { ok: true, amountCents: 200 } });
      expect((await walletRow(root.id)).monthlyRemainingCents).toBe(4_500);
      expect((await walletRow(child.id)).topupRemainingCents).toBe(500);
    } finally {
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, [child.id, root.id]));
      await db.delete(wallets).where(eq(wallets.id, child.id));
      await db.delete(drives).where(eq(drives.id, notes.id));
    }
  }, 20_000);
  it('WAL-3 (partial) two top-ups racing with the same idempotency key land once: one moves the money, the other answers duplicate, neither fails', async () => {
    if (!world) return;
    const key = createId();
    const [a, b] = await Promise.all([
      topUpDriveWallet(credentialActor(world.ids.priya, null), world.productId, { amountCents: 1_000, idempotencyKey: key }, 'session'),
      topUpDriveWallet(credentialActor(world.ids.priya, null), world.productId, { amountCents: 1_000, idempotencyKey: key }, 'session'),
    ]);
    expect([a, b].map((r) => r.ok)).toEqual([true, true]);
    expect([a, b].filter((r) => r.ok && r.duplicate)).toHaveLength(1);
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 1_000);
    expect((await walletRow(world.productWalletId)).topupRemainingCents).toBe(1_000);
  });
  it('refuses outsider reads and writes without exposing or changing money', async () => {
    if (!world) return;
    const w = world;
    const actor = credentialActor(w.ids.outsider, null);
    const before = await walletRow(w.productWalletId);
    const results = [
      await getDriveWallet(actor, w.productId, 'session'),
      await createDriveWallet(actor, w.productId, { allocationCents: 100 }, 'session'),
      await updateDriveWallet(actor, w.productId, { paused: true }, 'session'),
      await deleteDriveWallet(actor, w.productId, 'session'),
      await topUpDriveWallet(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session'),
      await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session'),
      await listDriveWalletCaps(actor, w.productId, 'session'),
      await setDriveWalletCap(actor, w.productId, w.ids.marcus, { dailyCents: 10 }, 'session'),
    ];
    for (const result of results) expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await walletRow(w.productWalletId)).toEqual(before);
  });

  it('reports an absent wallet to an authorized admin and refuses money writes', async () => {
    if (!world) return;
    const w = world;
    await db.delete(creditLedger).where(eq(creditLedger.walletId, w.productWalletId));
    await db.delete(wallets).where(eq(wallets.id, w.productWalletId));
    const actor = credentialActor(w.ids.priya, null);
    const before = await walletRow(w.poolId);
    expect(await getDriveWallet(actor, w.productId, 'session')).toMatchObject({ ok: true, wallet: null });
    const results = [
      await updateDriveWallet(actor, w.productId, { paused: true }, 'session'),
      await deleteDriveWallet(actor, w.productId, 'session'),
      await topUpDriveWallet(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session'),
      await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session'),
      await listDriveWalletCaps(actor, w.productId, 'session'),
      await setDriveWalletCap(actor, w.productId, w.ids.marcus, { dailyCents: 10 }, 'session'),
    ];
    for (const result of results) expect(result).toMatchObject({ ok: false, status: 404, code: 'no_wallet' });
    expect(await walletRow(w.poolId)).toEqual(before);
  });

  it('rejects malformed allocations and top-ups without balance or ledger changes', async () => {
    if (!world) return;
    const w = world;
    const actor = credentialActor(w.ids.priya, null);
    const before = await walletRow(w.productWalletId);
    const poolBefore = await walletRow(w.poolId);
    const ledgerBefore = await db.select().from(creditLedger).where(eq(creditLedger.walletId, w.productWalletId));
    for (const amount of [-1, 0.5]) {
      expect(await createDriveWallet(actor, w.productId, { allocationCents: amount }, 'session')).toMatchObject({ ok: false, status: 400, code: 'invalid_amount' });
      expect(await updateDriveWallet(actor, w.productId, { allocationCents: amount }, 'session')).toMatchObject({ ok: false, status: 400, code: 'invalid_amount' });
      expect(await topUpDriveWallet(actor, w.productId, { amountCents: amount, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 400, code: 'invalid_amount' });
    }
    expect(await updateDriveWallet(actor, w.productId, {}, 'session')).toMatchObject({ ok: false, status: 400 });
    expect(await createDriveWallet(actor, w.productId, { allocationCents: 100 }, 'session')).toMatchObject({ ok: false, status: 409, code: 'wallet_exists' });
    expect(await walletRow(w.productWalletId)).toEqual(before);
    expect(await walletRow(w.poolId)).toEqual(poolBefore);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, w.productWalletId))).toEqual(ledgerBefore);
  });

  it('repays drive debt before exposing top-up credit and resumes an overdrawn wallet', async () => {
    if (!world) return;
    const w = world;
    await db.update(wallets).set({ status: 'over', debtCents: 300 }).where(eq(wallets.id, w.productWalletId));
    expect(await topUpDriveWallet(credentialActor(w.ids.priya, null), w.productId, { amountCents: 500, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, amountCents: 500, paidDebtCents: 300, duplicate: false });
    expect(await walletRow(w.productWalletId)).toMatchObject({ status: 'active', debtCents: 0, topupRemainingCents: 200 });
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 500);
    expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId))).toEqual([expect.objectContaining({ originalCents: 500, remainingCents: 200 })]);
  });

  it('maps donation refusals and retries without charging the donor twice', async () => {
    if (!world) return;
    const w = world;
    const actor = credentialActor(w.ids.marcus, null);
    const [root] = await db.select().from(wallets).where(personalRootWalletOf(w.ids.marcus));
    const before = await walletRow(root.id);
    expect(await donateToDrive(actor, w.productId, { amountCents: 6000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
    expect(await donateToDrive(actor, w.productId, { amountCents: -1, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 400 });
    await db.update(wallets).set({ donationsEnabled: false }).where(eq(wallets.id, w.productWalletId));
    expect(await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'donations_disabled' });
    await db.update(wallets).set({ donationsEnabled: true }).where(eq(wallets.id, w.productWalletId));
    process.env.DEPLOYMENT_MODE = 'onprem';
    expect(await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'billing_disabled' });
    expect(await topUpDriveWallet(credentialActor(w.ids.priya, null), w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'billing_disabled' });
    expect(await walletRow(root.id)).toEqual(before);
    process.env.DEPLOYMENT_MODE = 'cloud';
    const key = createId();
    expect(await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, amountCents: 100, duplicate: false });
    expect(await donateToDrive(actor, w.productId, { amountCents: 100, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, amountCents: 100, duplicate: true });
    expect((await walletRow(root.id)).monthlyRemainingCents).toBe(before.monthlyRemainingCents - 100);
    expect((await walletRow(w.productWalletId)).topupRemainingCents).toBe(100);
  });

  it('refuses a top-up whose wallet was removed after authorization without debiting its funder', async () => {
    if (!world) return;
    const w = world;
    const before = await walletRow(w.poolId);
    expect(await topUpDriveWallet(credentialActor(w.ids.priya, null), w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session', {
      afterAccess: async () => {
        await db.delete(creditLedger).where(eq(creditLedger.walletId, w.productWalletId));
        await db.delete(wallets).where(eq(wallets.id, w.productWalletId));
      },
    })).toMatchObject({ ok: false, status: 404, code: 'no_wallet' });
    expect(await walletRow(w.poolId)).toEqual(before);
  });

  it('shows empty pool and seat views before an organization receives a pool', async () => {
    if (!world) return;
    const w = world;
    await db.delete(creditLedger).where(inArray(creditLedger.walletId, [w.productWalletId, w.researchWalletId]));
    await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
    await db.delete(wallets).where(eq(wallets.id, w.poolId));
    expect(await listOrgSeatCaps(w.orgId)).toMatchObject({ walletId: null, seats: [] });
    expect(await getOrgPoolSplit(w.orgId)).toMatchObject({ walletId: null, availableCents: 0, driveWallets: [], drivesWithoutWallet: [] });
    expect(await createDriveWallet(credentialActor(w.ids.priya, null), w.productId, { allocationCents: 100 }, 'session')).toMatchObject({ ok: false, status: 409, code: 'no_org_pool' });
    expect(await setSeatCap(w.ids.priya, w.orgId, w.ids.marcus, { dailyCents: 100 })).toMatchObject({ ok: false, status: 409, code: 'no_org_pool' });
    expect(await setOrgPoolPaused(w.ids.priya, w.orgId, true)).toMatchObject({ ok: false, status: 409, code: 'no_org_pool' });
  });
  it('creates a personal drive wallet under its lead root, funds it and lists only the lead funds', async () => {
    if (!world) return;
    const w = world;
    const actor = credentialActor(w.ids.dana, null);
    const drive = await factories.createDrive(w.ids.dana);
    try {
      expect(await getAlwaysOwnCredits(w.ids.dana, null)).toEqual({ ok: true, alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false });
      expect(await createDriveWallet(actor, drive.id, { allocationCents: 100 }, 'session')).toMatchObject({ ok: true });
      const [child] = await db.select().from(wallets).where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, drive.id)));
      const [root] = await db.select().from(wallets).where(personalRootWalletOf(w.ids.dana));
      expect(child).toMatchObject({ ownerType: 'user', userId: w.ids.dana, orgId: null, parentWalletId: root.id });
      await db.update(wallets).set({ monthlyRemainingCents: 1000 }).where(eq(wallets.id, root.id));
      expect(await topUpDriveWallet(actor, drive.id, { amountCents: 250, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
      expect((await walletRow(root.id)).monthlyRemainingCents).toBe(750);
      expect((await walletRow(child.id)).topupRemainingCents).toBe(250);
      const view = await listMyWallets(actor, 'session');
      expect(view.funds.driveWallets).toEqual([expect.objectContaining({ driveId: drive.id, walletId: child.id })]);
      expect(view.funds.pools).toEqual([]);
    } finally {
      const rows = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.subjectId, drive.id));
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, rows.map(row => row.id)));
      await db.delete(wallets).where(eq(wallets.subjectId, drive.id));
      await db.delete(drives).where(eq(drives.id, drive.id));
    }
  });

  it('refuses a donation after the donor root disappears and does not create a funding leg', async () => {
    if (!world) return;
    const w = world;
    const before = await walletRow(w.productWalletId);
    expect(await donateToDrive(credentialActor(w.ids.marcus, null), w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session', {
      afterAccess: async () => { await db.delete(wallets).where(personalRootWalletOf(w.ids.marcus)); },
    })).toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
    expect(await walletRow(w.productWalletId)).toEqual(before);
    expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId))).toEqual([]);
  });

  it('refuses a wallet write after its drive disappears without debiting the pool', async () => {
    if (!world) return;
    const w = world;
    const before = await walletRow(w.poolId);
    expect(await createDriveWallet(credentialActor(w.ids.priya, null), w.researchId, { allocationCents: 100 }, 'session', {
      afterAccess: async () => { await db.delete(drives).where(eq(drives.id, w.researchId)); },
    })).toMatchObject({ ok: false, status: 404 });
    expect(await walletRow(w.poolId)).toEqual(before);
  });

  it.each(['weak', 'expired'] as const)('refuses %s credentials at drive-wallet and conversation entry points before a source changes', async (kind) => {
    if (!world) return;
    const w = world;
    await db.update(organizations).set({ policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 } }).where(eq(organizations.id, w.orgId));
    const actor = credentialActor(w.ids.marcus, { authenticatedAtMs: kind === 'expired' ? Date.now() - 3600000 : Date.now(), assurance: kind === 'weak' ? 'single_factor' : 'user_verified_passkey' });
    const [conversation] = await db.insert(conversations).values({ userId: w.ids.marcus, type: 'drive', contextId: w.productId, title: 'Policy-bound spend', chosenWalletId: w.productWalletId }).returning();
    const expected = { ok: false, status: 403, code: kind === 'weak' ? 'org_strong_sign_in_required' : 'org_reauthentication_required' };
    expect(await getDriveWallet(actor, w.productId, 'session')).toMatchObject(expected);
    expect(await getConversationSpend(actor, conversation.id)).toMatchObject(expected);
    expect(await setConversationSpend(actor, conversation.id, null, 'session')).toMatchObject(expected);
    expect((await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0].chosenWalletId).toBe(w.productWalletId);
  });

  it('confines an automation source reader and writer to the automation drive', async () => {
    if (!world) return;
    const w = world;
    const [conversation] = await db.insert(conversations).values({ userId: w.ids.priya, type: 'drive', contextId: w.productId, title: 'Scoped automation', chosenWalletId: w.productWalletId }).returning();
    const actor = automationActor(w.ids.priya, 'scheduled workflow', inDrives(w.researchId));
    expect(await getConversationSpend(actor, conversation.id)).toMatchObject({ ok: false, status: 404 });
    expect(await setConversationSpend(actor, conversation.id, null, 'session')).toMatchObject({ ok: false, status: 404 });
    expect((await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0].chosenWalletId).toBe(w.productWalletId);
  });
});
