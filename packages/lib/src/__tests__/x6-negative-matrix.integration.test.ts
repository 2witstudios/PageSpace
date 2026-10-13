/**
 * The Spec X-6 negative matrix, in one place, against a REAL Postgres:
 *
 *   "a non-member cannot see an Open drive of another org; a guest cannot see a second drive;
 *    a policy set to off refuses; an empty chosen wallet charges nothing; an automation never
 *    charges a person."
 *
 * Each behaviour is also proven in its own lane's suite (org-drive-resolvers, share-link-policy,
 * wallet-gate, automation-spend), where it sits among many partial claims. This file is the one
 * place every clause is exercised end to end through the REAL resolvers and gates — nothing about
 * the decision is mocked; only the dark-ship ORGS_ENABLED constant is forced on, and the org audit
 * append is stubbed so a policy change does not need the audit store.
 *
 * Every "refuses" is paired with its "and nothing happened": no access row or grant was created,
 * no hold or ledger row was written, and no wallet balance — above all no person's — moved.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes only the rows it creates, children before parents, users last.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/__tests__/x6-negative-matrix.integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { automationSkipNotices, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import type { SessionClaims } from '../auth/session-service';
import { EnforcedAuthContext } from '../permissions/enforced-context';
import { getUserAccessLevel } from '../permissions/permissions';
import { credentialActor } from '../permissions/access-actor';
import { createDriveShareLink, createPageShareLink, redeemDriveShareLink, redeemPageShareLink } from '../permissions/share-link-service';
import { listPendingGuestApprovals } from '../permissions/guest-holds';
import { getDriveAccess, listAccessibleDrives, type ListDrivesOptions } from '../services/drive-service';
import { canConsumeAI } from '../billing/credit-gate';
import { automationSpend, conversationSpend } from '../billing/spend-target';
import { cleanupNorthwind, northwind } from '../permissions/__tests__/fixtures/northwind-org-drives';

vi.mock('../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

import { updateOrgPolicies } from '../organizations/policies';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

const LIST_OPTIONS: ListDrivesOptions[] = [{}, { includeTrash: true }, { tokenScopable: true }];
const listedIds = async (userId: string, options?: ListDrivesOptions) =>
  (await listAccessibleDrives(credentialActor(userId, null), options)).map((d) => d.id).sort();
const NO_MEMBERSHIP = { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };

// ── Rows this file creates outside the Northwind fixture (which tracks its own) ──
const created = { userIds: [] as string[], orgIds: [] as string[] };

async function newUser(name?: string): Promise<string> {
  const u = await factories.createUser({ name: name ?? 'X6 User', subscriptionTier: 'free' });
  created.userIds.push(u.id);
  return u.id;
}

async function newPaidOrg(ownerId: string, policies: Record<string, unknown> = {}): Promise<string> {
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `x6-nw-${createId()}`, ownerId, policies }).returning();
  created.orgIds.push(org.id);
  // Paid: an unpaid org is lapsed (D-OW-30), and a lapsed org's legs read as paused.
  await factories.createOrgSubscription(org.id);
  return org.id;
}

async function cleanupCreated(): Promise<void> {
  const { userIds, orgIds } = created;
  if (userIds.length) {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(conversations).where(inArray(conversations.userId, userIds));
    await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, userIds));
    await db.delete(creditHolds).where(inArray(creditHolds.userId, userIds));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
  }
  if (orgIds.length) {
    const orgDriveIds = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.orgId, orgIds))).map((d) => d.id);
    if (orgDriveIds.length) await db.delete(automationSkipNotices).where(inArray(automationSkipNotices.driveId, orgDriveIds));
    // Child wallets before their parents (parentWalletId has no cascade).
    await db.delete(wallets).where(and(inArray(wallets.orgId, orgIds), eq(wallets.subjectType, 'drive')));
    await db.delete(wallets).where(inArray(wallets.orgId, orgIds));
    await db.delete(drives).where(inArray(drives.orgId, orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  if (userIds.length) {
    await db.delete(wallets).where(inArray(wallets.userId, userIds));
    await db.delete(drives).where(inArray(drives.ownerId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  created.userIds = [];
  created.orgIds = [];
}

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

/**
 * Northwind's money: the paid org pool, Product's drive wallet under it with an EMPTY allocation, and
 * Marcus (an org member) with well-funded own credits — the wallet that must never be reached.
 */
async function emptyProductWallet() {
  const jono = await newUser('Jono');
  const marcus = await newUser('Marcus Oyelaran');
  const orgId = await newPaidOrg(jono);
  await db.insert(orgMembers).values([
    { orgId, userId: jono, role: 'OWNER' },
    { orgId, userId: marcus, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono, { name: 'Product', slug: `product-${createId()}`, orgId, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus, { source: 'org' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId,
    monthlyRemainingCents: 5_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId,
    subjectType: 'drive',
    subjectId: product.id,
    parentWalletId: poolWallet.id,
    monthlyAllowanceCents: 0,
  }).returning();
  const [marcusWallet] = await db.insert(wallets).values({
    userId: marcus,
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return { jono, marcus, orgId, productId: product.id, poolWallet, productWallet, marcusWallet };
}

type MoneyWorld = Awaited<ReturnType<typeof emptyProductWallet>>;

/** Nothing moved: no hold or ledger row against anyone or any wallet here, and every balance as it was. */
async function expectNothingCharged(m: MoneyWorld): Promise<void> {
  const walletIds = [m.poolWallet.id, m.productWallet.id, m.marcusWallet.id];
  expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, [m.marcus, m.jono]))).toEqual([]);
  expect(await db.select().from(creditHolds).where(inArray(creditHolds.walletId, walletIds))).toEqual([]);
  expect(await db.select().from(creditLedger).where(inArray(creditLedger.userId, [m.marcus, m.jono]))).toEqual([]);
  expect(await db.select().from(creditLedger).where(inArray(creditLedger.walletId, walletIds))).toEqual([]);
  const after = await db.select().from(wallets).where(inArray(wallets.id, walletIds));
  const byId = new Map(after.map((w) => [w.id, w]));
  for (const before of [m.poolWallet, m.productWallet, m.marcusWallet]) {
    const now = byId.get(before.id);
    expect(now, before.id).toBeDefined();
    expect({
      monthlyRemainingCents: now?.monthlyRemainingCents,
      topupRemainingCents: now?.topupRemainingCents,
      spentCents: now?.spentCents,
      debtCents: now?.debtCents,
    }).toEqual({
      monthlyRemainingCents: before.monthlyRemainingCents,
      topupRemainingCents: before.topupRemainingCents,
      spentCents: before.spentCents,
      debtCents: before.debtCents,
    });
  }
}

describe('X-6 negative tests (real PG)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('x6-negative-matrix.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (!dbAvailable) return;
    await cleanupNorthwind();
    await cleanupCreated();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('X-6 a non-member of Northwind resolves no access to its Open drive', async () => {
    if (!dbAvailable) return;
    const f = await northwind();
    // Dana is in Acme, not Northwind, and still holds a stale org-sourced row on Product (OPEN) from
    // when she was; a fresh outsider holds no row at all. Neither is a Northwind member.
    const stranger = await newUser('Sam Stranger');

    for (const outsider of [f.people.dana.id, stranger]) {
      for (const target of [f.drives.product.id, f.pages.productPage.id, f.pages.productPrivatePage.id]) {
        expect(await getUserAccessLevel(credentialActor(outsider, null), target), `${outsider} ${target}`).toBeNull();
      }
      expect(await getDriveAccess(f.drives.product.id, credentialActor(outsider, null))).toEqual(NO_MEMBERSHIP);
      for (const options of LIST_OPTIONS) {
        expect(await listedIds(outsider, options)).not.toContain(f.drives.product.id);
      }
    }
    // Their own org's Open drive is unaffected: the refusal is about Northwind, not about Dana.
    expect(await listedIds(f.people.dana.id)).toEqual([f.drives.acmeWiki.id, f.drives.personal.id].sort());
    expect(await listedIds(stranger)).toEqual([]);

    // Not vacuous: a Northwind member with NO row resolves the same Open drive through its default role.
    expect(await getUserAccessLevel(credentialActor(f.people.nina.id, null), f.drives.product.id)).toMatchObject({ canView: true });
    expect(await listedIds(f.people.nina.id)).toContain(f.drives.product.id);
  });

  it('X-6 a guest invited to one Northwind drive cannot see a second', async () => {
    if (!dbAvailable) return;
    const f = await northwind();
    // A second OPEN Northwind drive beside Product, so "second drive" includes the visibility an org
    // member would reach without a row — not only the Restricted and Private ones.
    const design = await factories.createDrive(f.people.lena.id, { name: 'Design', slug: `design-${createId()}`, orgId: f.org.id, orgVisibility: 'OPEN' });
    const designPage = await factories.createPage(design.id, { title: 'Brand' });
    const chris = f.people.chris.id;

    // Chris was invited to Product only (and holds one page share inside Finance).
    for (const options of LIST_OPTIONS) {
      expect(await listedIds(chris, options)).toEqual([f.drives.product.id]);
    }
    for (const second of [design.id, f.drives.research.id, f.drives.finance.id]) {
      expect(await getUserAccessLevel(credentialActor(chris, null), second), second).toBeNull();
      expect(await getDriveAccess(second, credentialActor(chris, null)), second).toEqual(NO_MEMBERSHIP);
    }
    expect(await getUserAccessLevel(credentialActor(chris, null), designPage.id)).toBeNull();
    expect(await getUserAccessLevel(credentialActor(chris, null), f.pages.researchPage.id)).toBeNull();

    // Not vacuous: the invited drive does resolve for him, and the second Open drive does for a member.
    expect(await getDriveAccess(f.drives.product.id, credentialActor(chris, null))).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: null });
    expect(await getUserAccessLevel(credentialActor(f.people.nina.id, null), design.id)).toMatchObject({ canView: true });
  });

  it('X-6 a policy set to off refuses (guests off: share-link redemption)', async () => {
    if (!dbAvailable) return;
    const owner = await newUser('Jono');
    const orgId = await newPaidOrg(owner, { guests: 'on' });
    await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });
    const orgDrive = await factories.createDrive(owner, { name: 'Product', slug: `product-${createId()}`, orgId, orgVisibility: 'OPEN' });
    const orgPage = await factories.createPage(orgDrive.id, { isPrivate: false });

    // Both links exist while guests are on…
    const driveLink = await createDriveShareLink(ctxFor(owner), orgDrive.id, {});
    const pageLink = await createPageShareLink(ctxFor(owner), orgPage.id, { permissions: ['VIEW'] });
    if (!driveLink.ok || !pageLink.ok) throw new Error('setup: links should be creatable while guests are on');
    // …then the Owner sets the guests policy to off.
    await updateOrgPolicies({ orgId, actorId: owner, actorAuthentication: null, patch: { guests: 'off' } });
    const outsider = await newUser('Gus Guest');

    expect(await redeemDriveShareLink(ctxFor(outsider), driveLink.data.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await redeemPageShareLink(ctxFor(outsider), pageLink.data.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });

    // Nothing was created: no drive row, no page grant, nothing queued, and no access resolves.
    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, orgDrive.id), eq(driveMembers.userId, outsider)))).toEqual([]);
    expect(await db.$count(pagePermissions, eq(pagePermissions.userId, outsider))).toBe(0);
    expect((await listPendingGuestApprovals(orgId, 10)).total).toBe(0);
    expect(await getUserAccessLevel(credentialActor(outsider, null), orgPage.id)).toBeNull();
    expect(await listedIds(outsider)).toEqual([]);
  });

  it('X-6 an empty chosen wallet refuses and charges zero', async () => {
    if (!dbAvailable) return;
    const m = await emptyProductWallet();
    // Marcus CHOSE Product's (empty) drive wallet for this conversation; his own credits are funded.
    const [conversation] = await db
      .insert(conversations)
      .values({ userId: m.marcus, type: 'drive', contextId: m.productId, chosenWalletId: m.productWallet.id, updatedAt: new Date() })
      .returning({ id: conversations.id });

    const gate = await canConsumeAI(m.marcus, 'free', { spend: conversationSpend(m.productId, conversation.id) });

    // Refused by name; the other sources are OFFERED to the person, never silently spent.
    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'source_empty', options: ['seat_allowance', 'own_credits'] },
    });
    await expectNothingCharged(m);
  });

  it('X-6 an automation whose drive wallet is empty is skipped and charges no person', async () => {
    if (!dbAvailable) return;
    const m = await emptyProductWallet();

    // A person-less run in Product (a workflow Marcus made), recorded against Marcus.
    const gate = await canConsumeAI(m.marcus, 'free', { spend: automationSpend(m.productId), skipDailyCap: true });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] },
    });
    // No person is offered as a fallback, and none is charged: not Marcus, not the Owner, not the pool.
    await expectNothingCharged(m);
  });
});
