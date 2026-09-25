/**
 * The drive-wallet service against a real Postgres, per role (Spec SPEND-2, SPEND-3, SPEND-9,
 * SPEND-10, UI-9, UI-10, WAL-3, WAL-4): the REAL access model (drive relationships, org roles)
 * over a small Northwind Labs (Sequence Spec fixture), with ORGS_ENABLED on.
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
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { CONSUMER_WALLET_FIELDS } from '../../billing/wallet-views';
import {
  getDriveWallet,
  createDriveWallet,
  updateDriveWallet,
  deleteDriveWallet,
  topUpDriveWallet,
  donateToDrive,
  listMyWallets,
  setPersonalDefaultSource,
  getConversationSpend,
  setConversationSpend,
} from '../drive-wallet-service';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

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
  await db.delete(conversations).where(inArray(conversations.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  const children = db.select({ id: wallets.id }).from(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(walletFundingLegs).where(inArray(walletFundingLegs.walletId, children));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];

describe('drive-wallet service (orgs on, real Postgres)', () => {
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

  it('SPEND-9 (partial) X-6 (partial) a MEMBER sees the remaining amount and their own cap only — never the pool balance or another consumer\'s spend', async () => {
    if (!world) return;
    const read = await getDriveWallet(world.ids.marcus, world.productId, 'session');
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
    const read = await getDriveWallet(world.ids.chris, world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'guest' });
    if (!read.ok || !read.wallet) throw new Error('expected a wallet');
    expect(Object.keys(read.wallet).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
    expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
  });

  it('SPEND-10 (partial) the drive LEAD sees spend by member for their drive, but never the pool', async () => {
    if (!world) return;
    const read = await getDriveWallet(world.ids.dana, world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'lead' });
    if (!read.ok || !read.wallet || read.wallet.viewer !== 'lead') throw new Error('expected a lead view');
    expect(read.wallet.spendByConsumer).toEqual([
      { consumerKey: `user:${world.ids.marcus}`, userId: world.ids.marcus, spentCents: MARCUS_SPEND },
      { consumerKey: `user:${world.ids.lena}`, userId: world.ids.lena, spentCents: LENA_SPEND },
    ]);
    expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
    expect('pool' in read.wallet).toBe(false);
  });

  it('SPEND-10 (partial) an ORG ADMIN sees every wallet field, the pool and the unallocated balance', async () => {
    if (!world) return;
    const read = await getDriveWallet(world.ids.priya, world.productId, 'session');
    expect(read).toMatchObject({ ok: true, viewer: 'org_admin' });
    if (!read.ok || !read.wallet || read.wallet.viewer !== 'org_admin') throw new Error('expected an admin view');
    const outstanding = (120_000 - LENA_SPEND - MARCUS_SPEND) + 60_000;
    expect(read.wallet.pool).toEqual({ walletId: world.poolId, availableCents: POOL_CENTS, unallocatedCents: POOL_CENTS - outstanding });
  });

  it('SPEND-9 (partial) X-6 (partial) a NON-MEMBER gets 404: an outsider on Product, an org member who has not joined a Restricted drive', async () => {
    if (!world) return;
    expect(await getDriveWallet(world.ids.outsider, world.productId, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await getDriveWallet(world.ids.tomas, world.researchId, 'session')).toMatchObject({ ok: false, status: 404 });
    expect(await donateToDrive(world.ids.tomas, world.researchId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 404 });
  });

  // -------------------------------------------------------------------------
  // What each role may change (UI-9)
  // -------------------------------------------------------------------------

  it('UI-9 (partial) a member and a guest cannot change the wallet; the lead can pause and set rules but not move pool money', async () => {
    if (!world) return;
    for (const who of [world.ids.marcus, world.ids.chris]) {
      expect(await updateDriveWallet(who, world.productId, { paused: true }, 'session')).toMatchObject({ ok: false, status: 403 });
      expect(await updateDriveWallet(who, world.productId, { allocationCents: 1 }, 'session')).toMatchObject({ ok: false, status: 403 });
    }
    expect(await updateDriveWallet(world.ids.dana, world.productId, { allocationCents: 999_999 }, 'session')).toMatchObject({ ok: false, status: 403, code: 'insufficient_role' });
    // A mixed change is refused whole: nothing from it lands.
    expect(await updateDriveWallet(world.ids.dana, world.productId, { paused: true, allocationCents: 1 }, 'session')).toMatchObject({ ok: false, status: 403 });
    expect((await walletRow(world.productWalletId)).status).toBe('active');

    const paused = await updateDriveWallet(world.ids.dana, world.productId, { paused: true, donationsEnabled: false, fallbackRule: 'own_credits', defaultSpendSource: 'drive_wallet' }, 'session');
    expect(paused).toMatchObject({ ok: true, wallet: { status: 'paused', donationsEnabled: false, fallbackRule: 'own_credits', defaultSpendSource: 'drive_wallet' } });
    expect(await topUpDriveWallet(world.ids.dana, world.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 403 });
  });

  it('UI-9 (partial) WAL-3 (partial) an org admin allocates and tops up from the pool; the top-up is an owner leg and a ledger pair', async () => {
    if (!world) return;
    expect(await updateDriveWallet(world.ids.priya, world.productId, { allocationCents: 150_000 }, 'session')).toMatchObject({ ok: true, wallet: { allocationCents: 150_000 } });
    const key = createId();
    const topUp = await topUpDriveWallet(world.ids.priya, world.productId, { amountCents: 10_000, idempotencyKey: key }, 'session');
    expect(topUp).toMatchObject({ ok: true, amountCents: 10_000, duplicate: false });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 10_000);
    expect((await walletRow(world.productWalletId)).topupRemainingCents).toBe(10_000);
    const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, world.productWalletId));
    expect(legs.map((l) => [l.funderKind, l.funderOrgId, l.originalCents, l.nonRefundable])).toEqual([['owner', world.orgId, 10_000, false]]);
    // Replaying the same key moves nothing.
    expect(await topUpDriveWallet(world.ids.priya, world.productId, { amountCents: 10_000, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, duplicate: true });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 10_000);
  });

  it('WAL-3 (partial) a top-up the pool cannot cover is refused whole and moves nothing', async () => {
    if (!world) return;
    expect(await topUpDriveWallet(world.ids.priya, world.productId, { amountCents: POOL_CENTS + 1, idempotencyKey: createId() }, 'session'))
      .toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(POOL_CENTS);
  });

  it('WAL-4 (partial) a member donates from their own balance; the lead can turn donations off', async () => {
    if (!world) return;
    expect(await donateToDrive(world.ids.marcus, world.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, amountCents: 1_000 });
    await updateDriveWallet(world.ids.dana, world.productId, { donationsEnabled: false }, 'session');
    expect(await donateToDrive(world.ids.marcus, world.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'donations_disabled' });
  });

  it('UI-9 (partial) a wallet that moved money is refused deletion with its blockers; an unused one deletes', async () => {
    if (!world) return;
    expect(await deleteDriveWallet(world.ids.priya, world.productId, 'session')).toMatchObject({ ok: false, status: 409, blockers: ['has_money_history'] });
    expect(await deleteDriveWallet(world.ids.dana, world.productId, 'session')).toMatchObject({ ok: false, status: 403 });
    expect(await deleteDriveWallet(world.ids.jono, world.researchId, 'session')).toEqual({ ok: true });
    expect(await getDriveWallet(world.ids.jono, world.researchId, 'session')).toMatchObject({ ok: true, wallet: null });
    // An org admin re-creates it under the pool.
    expect(await createDriveWallet(world.ids.priya, world.researchId, { allocationCents: 5_000 }, 'session')).toMatchObject({ ok: true, wallet: { allocationCents: 5_000 } });
    expect(await createDriveWallet(world.ids.priya, world.researchId, { allocationCents: 5_000 }, 'session')).toMatchObject({ ok: false, status: 409, code: 'wallet_exists' });
    const [row] = await db.select().from(wallets).where(eq(wallets.subjectId, world.researchId));
    expect([row.ownerType, row.orgId, row.parentWalletId]).toEqual(['org', world.orgId, world.poolId]);
  });

  // -------------------------------------------------------------------------
  // Settings › Usage › Wallets (UI-10) and the per-conversation source (SPEND-2, SPEND-3)
  // -------------------------------------------------------------------------

  it('UI-10 (partial) SPEND-9 (partial) a member lists what they spend from (drive wallets, their seat) with no pool balance; an admin also lists the pool they fund', async () => {
    if (!world) return;
    const marcus = await listMyWallets(world.ids.marcus, 'session');
    expect(marcus.driveWallets).toEqual([{ driveId: world.productId, walletId: world.productWalletId, status: 'active', remainingCents: 120_000 - LENA_SPEND - MARCUS_SPEND, remainingCredits: (120_000 - LENA_SPEND - MARCUS_SPEND).toLocaleString('en-US') }]);
    expect(marcus.seats).toEqual([{ orgId: world.orgId, walletId: world.poolId }]);
    expect(marcus.funds.pools).toEqual([]);
    expect(JSON.stringify(marcus)).not.toContain(String(POOL_CENTS));

    const priya = await listMyWallets(world.ids.priya, 'session');
    expect(priya.funds.pools).toEqual([expect.objectContaining({ orgId: world.orgId, walletId: world.poolId, availableCents: POOL_CENTS })]);
  });

  it('SPEND-3 (partial) UI-10 (partial) the person sets and clears their own default source', async () => {
    if (!world) return;
    expect(await setPersonalDefaultSource(world.ids.marcus, 'seat_allowance', 'session')).toEqual({ ok: true, defaultSpendSource: 'seat_allowance' });
    expect((await listMyWallets(world.ids.marcus, 'session')).personal.defaultSpendSource).toBe('seat_allowance');
    await setPersonalDefaultSource(world.ids.marcus, null, 'session');
    expect((await listMyWallets(world.ids.marcus, 'session')).personal.defaultSpendSource).toBeNull();
  });

  it('SPEND-2 (partial) SPEND-3 (partial) a conversation\'s source is chosen explicitly, persists, and the preview shows what the gate would spend', async () => {
    if (!world) return;
    const [conv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();

    const before = await getConversationSpend(world.ids.marcus, conv.id);
    expect(before).toMatchObject({ ok: true, chosenWalletId: null, resolved: { kind: 'refuse', reason: 'no_source_chosen' } });
    if (!before.ok) throw new Error('expected a read');
    expect(before.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);

    const chosen = await setConversationSpend(world.ids.marcus, conv.id, world.poolId, 'session');
    expect(chosen).toMatchObject({ ok: true, chosenWalletId: world.poolId, resolved: { kind: 'spend', source: 'seat_allowance', walletId: world.poolId } });
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].chosenWalletId).toBe(world.poolId);

    expect(await setConversationSpend(world.ids.marcus, conv.id, null, 'session')).toMatchObject({ ok: true, chosenWalletId: null });
  });

  it('SPEND-3 (partial) X-6 (partial) a conversation cannot store a wallet the person may not spend: another person\'s, a Restricted drive\'s they have not joined, the pool for a guest', async () => {
    if (!world) return;
    const [conv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    const [lenaWallet] = await db.insert(wallets).values({ userId: world.ids.lena }).returning();
    for (const walletId of [lenaWallet.id, world.researchWalletId, 'w-does-not-exist']) {
      expect(await setConversationSpend(world.ids.marcus, conv.id, walletId, 'session'), walletId).toMatchObject({ ok: false, status: 400, code: 'wallet_not_available' });
    }
    const [chrisConv] = await db.insert(conversations).values({ userId: world.ids.chris, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    for (const walletId of [world.poolId, world.productWalletId]) {
      expect(await setConversationSpend(world.ids.chris, chrisConv.id, walletId, 'session'), walletId).toMatchObject({ ok: false, status: 400 });
    }
    expect((await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].chosenWalletId).toBeNull();
  });

  it('SPEND-3 (partial) a person cannot read or change the source of someone else\'s conversation', async () => {
    if (!world) return;
    const [lenasConv] = await db.insert(conversations).values({ userId: world.ids.lena, type: 'drive', contextId: world.productId, updatedAt: new Date() }).returning();
    expect(await getConversationSpend(world.ids.marcus, lenasConv.id)).toMatchObject({ ok: false, status: 404 });
    expect(await setConversationSpend(world.ids.marcus, lenasConv.id, null, 'session')).toMatchObject({ ok: false, status: 404 });
  });
  it('SPEND-7 (partial) SPEND-3 (partial) a page conversation\'s options come from its page\'s drive; a global one offers own credits unless a drive is named, and a drive the person cannot open offers nothing more', async () => {
    if (!world) return;
    const page = await factories.createPage(world.productId, { title: 'Roadmap', type: 'AI_CHAT' });
    const [pageConv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'page', contextId: page.id, updatedAt: new Date() }).returning();
    const onPage = await getConversationSpend(world.ids.marcus, pageConv.id);
    expect(onPage.ok && onPage.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);

    const [globalConv] = await db.insert(conversations).values({ userId: world.ids.marcus, type: 'global', updatedAt: new Date() }).returning();
    const alone = await getConversationSpend(world.ids.marcus, globalConv.id);
    expect(alone.ok && alone.options.map((o) => o.source)).toEqual(['own_credits']);
    const inProduct = await getConversationSpend(world.ids.marcus, globalConv.id, world.productId);
    expect(inProduct.ok && inProduct.options.map((o) => o.source)).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    const inResearch = await getConversationSpend(world.ids.marcus, globalConv.id, world.researchId);
    expect(inResearch.ok && inResearch.options.map((o) => o.source)).toEqual(['own_credits']);
    expect(await setConversationSpend(world.ids.marcus, globalConv.id, world.researchWalletId, 'session', world.researchId)).toMatchObject({ ok: false, status: 400 });
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
      ['create', () => createDriveWallet(w.ids.priya, w.researchId, { allocationCents: 1 }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['allocate', () => updateDriveWallet(w.ids.priya, w.productId, { allocationCents: 1 }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['pause', () => updateDriveWallet(w.ids.priya, w.productId, { paused: true }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['rules', () => updateDriveWallet(w.ids.priya, w.productId, { donationsEnabled: false }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['top-up', () => topUpDriveWallet(w.ids.priya, w.productId, { amountCents: 1_000, idempotencyKey: key }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['donate', () => donateToDrive(w.ids.marcus, w.productId, { amountCents: 1_000, idempotencyKey: key }, 'mcp'), 'mcp_token_cannot_move_money'],
      ['delete', () => deleteDriveWallet(w.ids.jono, w.researchId, 'mcp'), 'mcp_token_cannot_move_money'],
      ['conversation source', () => setConversationSpend(w.ids.marcus, conv.id, w.poolId, 'mcp'), 'mcp_token_cannot_change_spend_source'],
      ['default source', () => setPersonalDefaultSource(w.ids.marcus, 'own_credits', 'mcp'), 'mcp_token_cannot_change_spend_source'],
    ];
    const before = await moneySnapshot(w);
    for (const [name, write, code] of writes) {
      expect(await write(), name).toMatchObject({ ok: false, status: 403, code });
    }
    expect(await moneySnapshot(w)).toBe(before);

    // The session path still works for each.
    expect(await updateDriveWallet(w.ids.priya, w.productId, { allocationCents: 130_000, paused: true, donationsEnabled: false }, 'session')).toMatchObject({ ok: true });
    await updateDriveWallet(w.ids.priya, w.productId, { paused: false, donationsEnabled: true }, 'session');
    expect(await topUpDriveWallet(w.ids.priya, w.productId, { amountCents: 1_000, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, duplicate: false });
    expect(await donateToDrive(w.ids.marcus, w.productId, { amountCents: 1_000, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
    expect(await deleteDriveWallet(w.ids.jono, w.researchId, 'session')).toEqual({ ok: true });
    expect(await createDriveWallet(w.ids.priya, w.researchId, { allocationCents: 1 }, 'session')).toMatchObject({ ok: true });
    expect(await setConversationSpend(w.ids.marcus, conv.id, w.poolId, 'session')).toMatchObject({ ok: true, chosenWalletId: w.poolId });
    expect(await setPersonalDefaultSource(w.ids.marcus, 'own_credits', 'session')).toEqual({ ok: true, defaultSpendSource: 'own_credits' });
    expect(await moneySnapshot(w)).not.toBe(before);
  });

  it('SPEND-9 (partial) [D-OW-26] read with a token, an org admin and a lead get exactly the consumer projection and no actions but view; my wallets drops pool balances', async () => {
    if (!world) return;
    for (const who of [world.ids.priya, world.ids.dana]) {
      const read = await getDriveWallet(who, world.productId, 'mcp');
      expect(read).toMatchObject({ ok: true, viewer: 'member', actions: ['view'] });
      if (!read.ok || !read.wallet) throw new Error('expected a wallet');
      expect(Object.keys(read.wallet).sort()).toEqual([...CONSUMER_WALLET_FIELDS].sort());
      expect(JSON.stringify(read)).not.toContain(String(POOL_CENTS));
      expect(JSON.stringify(read)).not.toContain(world.ids.lena);
    }
    const priya = await listMyWallets(world.ids.priya, 'mcp');
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
      expect(await topUpDriveWallet(world.ids.dana, notes.id, { amountCents: 500, idempotencyKey: createId() }, 'session'))
        .toMatchObject({ ok: false, status: 402, code: 'insufficient_funds' });
      expect((await walletRow(root.id)).monthlyRemainingCents).toBe(1_000);
      expect(await topUpDriveWallet(world.ids.dana, notes.id, { amountCents: 400, idempotencyKey: createId() }, 'session'))
        .toMatchObject({ ok: true, amountCents: 400 });
    } finally {
      await db.delete(creditHolds).where(eq(creditHolds.walletId, child.id));
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, [child.id, root.id]));
      await db.delete(walletFundingLegs).where(eq(walletFundingLegs.walletId, child.id));
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
      const donation = donateToDrive(world.ids.dana, notes.id, { amountCents: 200, idempotencyKey: createId() }, 'session');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const topUp = topUpDriveWallet(world.ids.dana, notes.id, { amountCents: 300, idempotencyKey: createId() }, 'session');
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
      await db.delete(walletFundingLegs).where(eq(walletFundingLegs.walletId, child.id));
      await db.delete(wallets).where(eq(wallets.id, child.id));
      await db.delete(drives).where(eq(drives.id, notes.id));
    }
  }, 20_000);
});
