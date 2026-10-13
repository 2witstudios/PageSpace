// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { conversationSpend } from '@pagespace/lib/billing/spend-target';
import { resolveCallSpend } from '@pagespace/lib/billing/spend-resolution';
import { consumeCredits } from '@pagespace/lib/billing/credit-consume';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isMCPAuthResult: (r: { tokenType: string }) => r.tokenType === 'mcp', getAllowedDriveIds: () => [], isAuthError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
import { authenticateRequestWithOptions } from '@/lib/auth';
import { PUT, GET } from '../conversations/[conversationId]/route';
import { GET as GET_WALLETS } from '../route';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

const ids: { users: string[]; drives: string[]; wallets: string[]; orgs: string[] } = { users: [], drives: [], wallets: [], orgs: [] };
afterEach(async () => {
  if (ids.users.length) {
    await db.delete(conversations).where(inArray(conversations.userId, ids.users));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, ids.users));
  }
  for (const id of ids.wallets.splice(0).reverse()) await db.delete(wallets).where(eq(wallets.id, id));
  if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives.splice(0)));
  if (ids.orgs.length) await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, ids.orgs));
  if (ids.orgs.length) await db.delete(organizations).where(inArray(organizations.id, ids.orgs.splice(0)));
  if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users.splice(0)));
});

describe('SPEND-2 (partial) SPEND-3 (partial) fresh global draft through the real wallet route and gate', () => {
  it.each(['weak', 'expired'] as const)('SEC-2 (partial) SEC-3 (partial) Given a %s org credential, should disclose no conversation wallet and change no choice while personal conversations remain usable', async kind => {
    const user = await factories.createUser({ subscriptionTier: 'pro' }); ids.users.push(user.id);
    const [org] = await db.insert(organizations).values({ name: 'route-security-credential-fixture', slug: createId(), ownerId: user.id, policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 } }).returning(); ids.orgs.push(org.id);
    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: 'OWNER' });
    await factories.createOrgSubscription(org.id);
    const orgDrive = await factories.createDrive(user.id, { orgId: org.id }); ids.drives.push(orgDrive.id);
    const personalDrive = await factories.createDrive(user.id); ids.drives.push(personalDrive.id);
    const [root] = await db.insert(wallets).values({ userId: user.id, monthlyRemainingCents: 10000 }).returning(); ids.wallets.push(root.id);
    const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 10000 }).returning(); ids.wallets.push(pool.id);
    const [child] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: orgDrive.id, parentWalletId: pool.id, monthlyAllowanceCents: 1000 }).returning(); ids.wallets.push(child.id);
    const [orgConv] = await db.insert(conversations).values({ userId: user.id, type: 'drive', contextId: orgDrive.id, chosenWalletId: child.id, updatedAt: new Date() }).returning();
    const [personal] = await db.insert(conversations).values({ userId: user.id, type: 'drive', contextId: personalDrive.id, updatedAt: new Date() }).returning();
    const [global] = await db.insert(conversations).values({ userId: user.id, type: 'global', updatedAt: new Date() }).returning();
    const auth: SessionAuthResult = { userId: user.id, tokenType: 'session', sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: { authenticatedAtMs: kind === 'expired' ? Date.now() - 3600000 : Date.now(), assurance: kind === 'weak' ? 'single_factor' : 'user_verified_passkey' } };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    const ctx = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });
    const url = `http://app.test/api/wallets/conversations/${orgConv.id}`;
    const read = await GET(new Request(url), ctx(orgConv.id));
    const write = await PUT(new Request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletId: root.id }) }), ctx(orgConv.id));
    expect({ read: read.status, write: write.status }).toEqual({ read: 403, write: 403 });
    expect(await read.json()).toMatchObject({ code: kind === 'weak' ? 'org_strong_sign_in_required' : 'org_reauthentication_required' });
    expect((await db.select().from(conversations).where(eq(conversations.id, orgConv.id)))[0].chosenWalletId).toBe(child.id);
    const overview = await GET_WALLETS(new Request('http://app.test/api/wallets'));
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ personal: { remainingCents: 10000 }, seats: [], driveWallets: [], funds: { pools: [] } });
    for (const id of [personal.id, global.id]) {
      const ownUrl = `http://app.test/api/wallets/conversations/${id}`;
      expect((await GET(new Request(ownUrl), ctx(id))).status).toBe(200);
      expect((await PUT(new Request(ownUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletId: root.id }) }), ctx(id))).status).toBe(200);
    }
  });

  it('Given a local draft, should create nothing on read, persist the deliberate choice, keep empty history hidden and charge its first call to that wallet', async () => {
    const user = await factories.createUser({ subscriptionTier: 'pro' }); ids.users.push(user.id);
    const drive = await factories.createDrive(user.id); ids.drives.push(drive.id);
    const [root] = await db.insert(wallets).values({ userId: user.id, monthlyRemainingCents: 10000 }).returning(); ids.wallets.push(root.id);
    const [child] = await db.insert(wallets).values({ userId: user.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: root.id, monthlyAllowanceCents: 1000, defaultSpendSource: 'drive_wallet' }).returning(); ids.wallets.push(child.id);
    const auth: SessionAuthResult = { userId: user.id, tokenType: 'session', sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' } };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    const id = createId();
    const url = `http://app.test/api/wallets/conversations/${id}?driveId=${drive.id}`;
    const context = { params: Promise.resolve({ conversationId: id }) };
    expect((await GET(new Request(url), context)).status).toBe(404);
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toEqual([]);
    const response = await PUT(new Request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletId: root.id, createGlobalDraft: true }) }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ conversationId: id, chosenWalletId: root.id, resolved: { kind: 'spend', walletId: root.id, source: 'own_credits' } });
    expect((await globalConversationRepository.listConversationsPaginated(user.id)).conversations).toEqual([]);
    const gate = await resolveCallSpend({ userId: user.id, consumerTier: 'pro', target: conversationSpend(drive.id, id), reservationCents: 5 });
    expect(gate).toMatchObject({ kind: 'spend', walletId: root.id, source: 'own_credits', fallbackApplied: false });
    if (gate.kind !== 'spend' || !gate.walletId) throw new Error('First call source was refused');
    await db.insert(messages).values({ id: createId(), conversationId: id, userId: user.id, role: 'user', content: 'First deliberate message', isActive: true });
    expect(await consumeCredits({ aiUsageLogId: createId(), userId: user.id, conversationId: id, costDollars: 0.01, walletId: gate.walletId })).toBe('settled');
    expect((await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id))).map(row => row.walletId)).toEqual([root.id]);
    expect((await db.select().from(wallets).where(eq(wallets.id, child.id)))[0].spentCents).toBe(0);
    expect((await globalConversationRepository.listConversationsPaginated(user.id)).conversations.map(row => row.id)).toEqual([id]);
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0].chosenWalletId).toBe(root.id);
    // A later refusal of the deliberately chosen source must not silently
    // send the next call to the still-funded drive wallet.
    await db.update(wallets).set({ monthlyRemainingCents: 0 }).where(eq(wallets.id, root.id));
    expect(await resolveCallSpend({ userId: user.id, consumerTier: 'pro', target: conversationSpend(drive.id, id), reservationCents: 5 })).toMatchObject({ kind: 'refuse', source: 'own_credits', chargeCents: 0 });
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0].chosenWalletId).toBe(root.id);
  });
});
