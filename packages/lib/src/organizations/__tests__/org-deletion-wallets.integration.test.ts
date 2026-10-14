import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../../audit/security-audit';
import { deleteOrganization, type DriveDeletionChoice } from '../deletion';

const auditKeys = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedAudit = new Map<string, string | undefined>();
const created = { users: [] as string[], orgs: [] as string[], drives: [] as string[] };
const resetAudit = () => { resetAuditDbBindingForTests(); resetDefaultSecurityAuditForTests(); };
beforeAll(async () => {
  for (const key of auditKeys) { savedAudit.set(key, process.env[key]); delete process.env[key]; }
  resetAudit();
  try { await db.select({ id: organizations.id }).from(organizations).limit(1); }
  catch (error) { requireDb('org-deletion-wallets.integration.test.ts', error); }
});
afterEach(async () => {
  if (created.drives.length) await db.delete(drives).where(inArray(drives.id, created.drives.splice(0)));
  const rows = await db.select().from(wallets);
  const ours = rows.filter(row => (row.userId && created.users.includes(row.userId)) || (row.orgId && created.orgs.includes(row.orgId)));
  for (const ids of [ours.filter(row => row.parentWalletId !== null).map(row => row.id), ours.filter(row => row.parentWalletId === null).map(row => row.id)]) {
    if (ids.length) await db.delete(wallets).where(inArray(wallets.id, ids));
  }
  if (created.orgs.length) {
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgs));
    await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  }
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});
afterAll(async () => {
  await pool.end();
  for (const [key, value] of savedAudit) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetAudit();
});
async function world() {
  const [owner, recipient, donor] = await factories.createUsers(3);
  created.users.push(owner.id, recipient.id, donor.id);
  const [org] = await db.insert(organizations).values({ ownerId: owner.id, name: 'Wallet closure', slug: `closure-${createId()}` }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([{ orgId: org.id, userId: owner.id, role: 'OWNER' }, { orgId: org.id, userId: recipient.id, role: 'MEMBER' }]);
  await factories.createOrgSubscription(org.id);
  const [root] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id }).returning();
  const deps = { endSubscription: vi.fn(async () => {}), ports: { broadcast: vi.fn(async () => {}), kick: vi.fn(async () => {}) } };
  return { owner, recipient, donor, org, root, deps };
}
async function funded(w: Awaited<ReturnType<typeof world>>, isTrashed = false) {
  const drive = await factories.createDrive(w.recipient.id, { orgId: w.org.id, isTrashed, ...(isTrashed ? { trashedAt: new Date() } : {}) });
  created.drives.push(drive.id);
  const page = await factories.createPage(drive.id);
  return db.transaction(async tx => {
  const [wallet] = await tx.insert(wallets).values({ ownerType: 'org', orgId: w.org.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: w.root.id, monthlyAllowanceCents: 200, spentCents: 30, topupRemainingCents: 777, debtCents: 20, status: 'paused' }).returning();
  const legs = await tx.insert(walletFundingLegs).values([
    { walletId: wallet.id, funderKind: 'donation', funderUserId: w.donor.id, originalCents: 700, remainingCents: 700, nonRefundable: true },
    { walletId: wallet.id, funderKind: 'owner', funderOrgId: w.org.id, originalCents: 77, remainingCents: 77, nonRefundable: false },
  ]).returning();
  const ledger = await tx.insert(creditLedger).values({ userId: w.donor.id, walletId: wallet.id, entryType: 'donation', bucket: 'topup', amountCents: 777, consumeStatus: 'applied' }).returning();
  return { drive, page, wallet, legs, ledger };
  });
}
const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
describe('organization closure preserves surviving drive wallets (real Postgres)', () => {
  it.each(['transfer', 'trash', 'already-trash'] as const)('Given a funded %s drive, should retain its wallet and immutable accounting history under the final owner', async action => {
    const w = await world(); const f = await funded(w, action === 'already-trash');
    const newOwner = action === 'transfer' ? w.recipient.id : w.owner.id;
    expect(await db.select().from(creditHolds).where(eq(creditHolds.walletId, f.wallet.id))).toEqual([]);
    const choices: DriveDeletionChoice[] = action === 'already-trash' ? [] : action === 'transfer' ? [{ driveId: f.drive.id, action, toUserId: newOwner }] : [{ driveId: f.drive.id, action }];
    expect((await deleteOrganization({ actorId: w.owner.id, orgId: w.org.id, choices, now: new Date() }, w.deps)).ok).toBe(true);
    expect(await walletRow(f.wallet.id)).toBeDefined();
    const [root] = await db.select().from(wallets).where(and(eq(wallets.userId, newOwner), isNull(wallets.subjectType)));
    expect(root).toBeDefined();
    expect(await walletRow(f.wallet.id)).toMatchObject({ id: f.wallet.id, ownerType: 'user', userId: newOwner, orgId: null, parentWalletId: root.id, topupRemainingCents: 777, monthlyAllowanceCents: 0, spentCents: 0, debtCents: 0, status: 'paused' });
    expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, f.wallet.id)).orderBy(walletFundingLegs.id)).toEqual([...f.legs].sort((a, b) => a.id.localeCompare(b.id)).map(leg => ({ ...leg, funderOrgId: null })));
    expect(await db.select().from(creditLedger).where(eq(creditLedger.id, f.ledger[0].id))).toEqual(f.ledger);
    expect(await db.select().from(creditLedger).where(and(eq(creditLedger.walletId, f.wallet.id), eq(creditLedger.entryType, 'debt_forgiven')))).toMatchObject([{ amountCents: 20, userId: w.owner.id }]);
    expect(await db.select().from(pages).where(eq(pages.id, f.page.id))).toHaveLength(1);
    expect((await db.select().from(drives).where(eq(drives.id, f.drive.id)))[0]).toMatchObject({ ownerId: newOwner, orgId: null, isTrashed: action !== 'transfer' });
    expect(w.deps.endSubscription).toHaveBeenCalledTimes(1);
  });
  it('Given a later drive wallet with a live hold, should refuse the whole closure and preserve settlement anchors and earlier wallet transitions', async () => {
    const w = await world(); const sorted = [await funded(w), await funded(w)].sort((a, b) => a.drive.id.localeCompare(b.drive.id));
    const blocked = sorted[1];
    const [hold] = await db.insert(creditHolds).values({ userId: w.recipient.id, walletId: blocked.wallet.id, estCents: 10, expiresAt: new Date(Date.now() + 60_000) }).returning();
    expect(await deleteOrganization({ actorId: w.owner.id, orgId: w.org.id, choices: sorted.map(f => ({ driveId: f.drive.id, action: 'transfer', toUserId: w.recipient.id })), now: new Date() }, w.deps)).toMatchObject({ ok: false, status: 409, reason: 'drive_wallet_calls_in_flight', driveIds: [blocked.drive.id] });
    for (const f of sorted) {
      expect(await walletRow(f.wallet.id)).toEqual(f.wallet);
      expect((await db.select().from(drives).where(eq(drives.id, f.drive.id)))[0].orgId).toBe(w.org.id);
      expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, f.wallet.id))).toEqual(f.legs);
      expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, f.wallet.id))).toEqual(f.ledger);
    }
    expect(await db.select().from(creditHolds).where(eq(creditHolds.id, hold.id))).toEqual([hold]);
    expect(await db.select().from(wallets).where(and(eq(wallets.userId, w.recipient.id), isNull(wallets.subjectType)))).toEqual([]);
    expect(await db.select().from(organizations).where(eq(organizations.id, w.org.id))).toHaveLength(1);
    expect(w.deps.endSubscription).not.toHaveBeenCalled();
    expect(w.deps.ports.broadcast).not.toHaveBeenCalled();
  });
  it('Given a non-owner or failed subscription cancellation, should retain wallet state and history', async () => {
    const w = await world(); const f = await funded(w);
    const input = { actorId: w.owner.id, orgId: w.org.id, choices: [{ driveId: f.drive.id, action: 'transfer' as const, toUserId: w.recipient.id }], now: new Date() };
    expect(await deleteOrganization({ ...input, actorId: w.recipient.id }, w.deps)).toMatchObject({ ok: false, status: 403 });
    expect(await walletRow(f.wallet.id)).toEqual(f.wallet);
    expect(w.deps.endSubscription).not.toHaveBeenCalled();
    w.deps.endSubscription.mockRejectedValueOnce(new Error('synthetic cancellation refusal'));
    await expect(deleteOrganization(input, w.deps)).rejects.toThrow('synthetic cancellation refusal');
    expect(await walletRow(f.wallet.id)).toEqual(f.wallet);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, f.wallet.id))).toEqual(f.ledger);
    expect((await db.select().from(drives).where(eq(drives.id, f.drive.id)))[0].orgId).toBe(w.org.id);
  });
});
