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
import { factories } from '@pagespace/db/test/factories';
import { conversationSpend } from '@pagespace/lib/billing/spend-target';
import { resolveCallSpend } from '@pagespace/lib/billing/spend-resolution';
import { consumeCredits } from '@pagespace/lib/billing/credit-consume';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isMCPAuthResult: (r: { tokenType: string }) => r.tokenType === 'mcp', getAllowedDriveIds: () => [], isAuthError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
import { authenticateRequestWithOptions } from '@/lib/auth';
import { PUT, GET } from '../conversations/[conversationId]/route';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';

const ids: { users: string[]; drives: string[]; wallets: string[] } = { users: [], drives: [], wallets: [] };
afterEach(async () => {
  if (ids.users.length) {
    await db.delete(conversations).where(inArray(conversations.userId, ids.users));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, ids.users));
  }
  for (const id of ids.wallets.splice(0).reverse()) await db.delete(wallets).where(eq(wallets.id, id));
  if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives.splice(0)));
  if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users.splice(0)));
});

describe('SPEND-2 (partial) SPEND-3 (partial) fresh global draft through the real wallet route and gate', () => {
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
