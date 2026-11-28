// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { resetAuditDbBindingForTests } from '@pagespace/lib/audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '@pagespace/lib/audit/security-audit';
import '../../../../../../../packages/lib/src/test/integration-wallet-arming';

// Exercise current domain source without rebuilding workspace packages. Only the
// post-commit transport is substituted; role, wallet and membership writes stay real.
vi.mock('@pagespace/lib/services/org-drive-service', async () => import('../../../../../../../packages/lib/src/services/org-drive-service'));
vi.mock('@pagespace/lib/services/org-drive-service-deps', async () => {
  const real = await import('../../../../../../../packages/lib/src/services/org-drive-service-deps');
  return { ...real, orgDriveServiceDeps: { ...real.orgDriveServiceDeps, syncOrgMembership: async (...args: Parameters<typeof real.orgDriveServiceDeps.syncOrgMembership>) => {
    await real.orgDriveServiceDeps.syncOrgMembership(...args);
    return async () => {};
  } } };
});
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: (value: object) => 'error' in value, getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [] }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/websocket', () => ({ broadcastDriveEvent: vi.fn(async () => {}), createDriveEventPayload: vi.fn(() => ({})) }));
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { PUT, DELETE } from '../[driveId]/org/route';

const created = { users: [] as string[], orgs: [] as string[], drives: [] as string[] };
const auditKeys = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedAudit = new Map<string, string | undefined>();
const resetAudit = () => { resetAuditDbBindingForTests(); resetDefaultSecurityAuditForTests(); };
beforeAll(async () => {
  for (const key of auditKeys) { savedAudit.set(key, process.env[key]); delete process.env[key]; }
  resetAudit();
  try { await db.select({ id: organizations.id }).from(organizations).limit(1); }
  catch (error) { requireDb('drive-economic-moves.integration.test.ts', error); }
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
  vi.clearAllMocks();
});
afterAll(async () => {
  await pool.end();
  for (const [key, value] of savedAudit) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetAudit();
});
async function seed(direction: 'in' | 'out', state: 'funded' | 'empty' | 'absent') {
  const owner = await factories.createUser(); created.users.push(owner.id);
  const [org] = await db.insert(organizations).values({ ownerId: owner.id, name: 'Economic authority', slug: `economic-${createId()}`, policies: { guests: 'on' } }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'OWNER' });
  await factories.createOrgSubscription(org.id);
  const drive = await factories.createDrive(owner.id, { orgId: direction === 'out' ? org.id : null }); created.drives.push(drive.id);
  const [personal] = await db.insert(wallets).values({ ownerType: 'user', userId: owner.id }).returning();
  const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id }).returning();
  const economic = state === 'absent' ? null : await db.transaction(async tx => {
    const [wallet] = await tx.insert(wallets).values({ ownerType: direction === 'out' ? 'org' : 'user', orgId: direction === 'out' ? org.id : null, userId: direction === 'in' ? owner.id : null, subjectType: 'drive', subjectId: drive.id, parentWalletId: direction === 'out' ? poolWallet.id : personal.id, topupRemainingCents: state === 'funded' ? 500 : 0, debtCents: state === 'funded' ? 20 : 0, monthlyAllowanceCents: state === 'funded' ? 50 : 0 }).returning();
    const legs = state === 'funded' ? await tx.insert(walletFundingLegs).values({ walletId: wallet.id, funderKind: 'donation', funderUserId: owner.id, originalCents: 500, remainingCents: 500, nonRefundable: true }).returning() : [];
    const ledger = state === 'funded' ? await tx.insert(creditLedger).values({ walletId: wallet.id, userId: owner.id, entryType: 'donation', bucket: 'topup', amountCents: 500, consumeStatus: 'applied' }).returning() : [];
    return { wallet, legs, ledger };
  });
  return { owner, org, drive, personal, poolWallet, economic };
}
function credential(userId: string, kind: 'session' | 'mcp', allowedDriveIds: string[] = []) {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(kind === 'session'
    ? { userId, tokenVersion: 0, tokenType: 'session', sessionId: 'test-session', role: 'user', adminRoleVersion: 0 }
    : { userId, tokenVersion: 0, tokenType: 'mcp', tokenId: 'test-key', role: 'user', adminRoleVersion: 0, allowedDriveIds });
}
function move(w: Awaited<ReturnType<typeof seed>>, direction: 'in' | 'out') {
  const body = direction === 'in' ? { orgId: w.org.id } : { implicitMembers: 'remove' };
  const request = new Request('http://local.test/api/drives/org', { method: direction === 'in' ? 'PUT' : 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (direction === 'in' ? PUT : DELETE)(request, { params: Promise.resolve({ driveId: w.drive.id }) });
}
describe('drive moves preserve session-only economic authority', () => {
  for (const direction of ['in', 'out'] as const) {
    it.each(['funded', 'empty'] as const)(`Given an unscoped key and a %s wallet moving ${direction}, should refuse before changing wallet control, debt, history or drive`, async state => {
      const w = await seed(direction, state); credential(w.owner.id, 'mcp');
      const response = await move(w, direction);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'mcp_token_cannot_move_money' });
      expect((await db.select().from(drives).where(eq(drives.id, w.drive.id)))[0]).toEqual(w.drive);
      if (!w.economic) throw new Error('Expected a wallet fixture');
      expect((await db.select().from(wallets).where(eq(wallets.id, w.economic.wallet.id)))[0]).toEqual(w.economic.wallet);
      expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.economic.wallet.id))).toEqual(w.economic.legs);
      expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, w.economic.wallet.id))).toEqual(w.economic.ledger);
      expect(auditRequest).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.write' }));
    });
    it(`Given a walletless drive moving ${direction}, should preserve the permitted unscoped-key metadata transition`, async () => {
      const w = await seed(direction, 'absent'); credential(w.owner.id, 'mcp');
      expect((await move(w, direction)).status).toBe(200);
      expect((await db.select().from(drives).where(eq(drives.id, w.drive.id)))[0].orgId).toBe(direction === 'in' ? w.org.id : null);
      expect(await db.select().from(wallets).where(eq(wallets.subjectId, w.drive.id))).toEqual([]);
    });
    it(`Given a session and funded drive moving ${direction}, should preserve its wallet and ledger debt forgiveness`, async () => {
      const w = await seed(direction, 'funded'); credential(w.owner.id, 'session');
      expect((await move(w, direction)).status).toBe(200);
      if (!w.economic) throw new Error('Expected a wallet fixture');
      expect((await db.select().from(wallets).where(eq(wallets.id, w.economic.wallet.id)))[0]).toMatchObject({ id: w.economic.wallet.id, ownerType: direction === 'in' ? 'org' : 'user', parentWalletId: direction === 'in' ? w.poolWallet.id : w.personal.id, topupRemainingCents: 500, debtCents: 0, monthlyAllowanceCents: 0 });
      expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.economic.wallet.id))).toEqual(w.economic.legs);
      expect(await db.select().from(creditLedger).where(and(eq(creditLedger.walletId, w.economic.wallet.id), eq(creditLedger.entryType, 'debt_forgiven')))).toMatchObject([{ amountCents: 20 }]);
    });
  }
  it('Given a drive-scoped key or non-member, should preserve existing scope and role refusals', async () => {
    const w = await seed('out', 'funded'); credential(w.owner.id, 'mcp', [w.drive.id]);
    expect((await move(w, 'out')).status).toBe(403);
    const outsider = await factories.createUser(); created.users.push(outsider.id); credential(outsider.id, 'session');
    const denied = await move(w, 'out');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'NOT_ORG_ADMIN' });
    expect((await db.select().from(drives).where(eq(drives.id, w.drive.id)))[0]).toEqual(w.drive);
  });
});
