// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { conversationSpend } from '@pagespace/lib/billing/spend-target';
import { resolveCallSpend } from '@pagespace/lib/billing/spend-resolution';
import { consumeCredits } from '@pagespace/lib/billing/credit-consume';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), checkMCPPageScope: vi.fn(async () => null), canPrincipalViewPage: async (auth: SessionAuthResult, pageId: string) => { const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions'); const { actorFromAuth } = await import('@/lib/auth/request-actor'); return canUserViewPage(actorFromAuth(auth), pageId); }, isMCPAuthResult: (r: { tokenType: string }) => r.tokenType === 'mcp', getAllowedDriveIds: () => [], isAuthError: (r: unknown) => !!r && typeof r === 'object' && 'error' in r }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
import { authenticateRequestWithOptions } from '@/lib/auth';
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({ checkSessionAccess: vi.fn(), findSessionRecord: vi.fn(), createConversationInSession: vi.fn() }));
vi.mock('@/lib/websocket/socket-utils', () => ({ broadcastAiConversationAdded: vi.fn() }));
vi.mock('@/lib/websocket/broadcast-triggered-by', () => ({ resolveTriggeredBy: vi.fn(async () => ({ userId: 'test' })) }));
import { POST } from '../route';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const ids: { users: string[]; drives: string[]; wallets: string[]; orgs: string[] } = { users: [], drives: [], wallets: [], orgs: [] };
afterEach(async () => {
  if (ids.users.length) {
    await db.delete(conversations).where(inArray(conversations.userId, ids.users));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, ids.users));
  }
  for (const id of ids.wallets.splice(0).reverse()) await db.delete(wallets).where(eq(wallets.id, id));
  if (ids.drives.length) await db.delete(pages).where(inArray(pages.driveId, ids.drives));
  if (ids.drives.length) await db.delete(drives).where(inArray(drives.id, ids.drives.splice(0)));
  if (ids.orgs.length) await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, ids.orgs));
  if (ids.orgs.length) await db.delete(organizations).where(inArray(organizations.id, ids.orgs.splice(0)));
  if (ids.users.length) await db.delete(users).where(inArray(users.id, ids.users.splice(0)));
});


describe('SPEND-2 (partial) SPEND-3 (partial) page-agent initial source through PostgreSQL', () => {
  it('Given only a page grant, should allow the grantee own-credit choice without exposing or charging the drive wallet', async () => {
    const owner = await factories.createUser(); ids.users.push(owner.id);
    const guest = await factories.createUser({ subscriptionTier: 'pro' }); ids.users.push(guest.id);
    const drive = await factories.createDrive(owner.id); ids.drives.push(drive.id);
    const agent = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    await factories.createPagePermission(agent.id, guest.id);
    const [root] = await db.insert(wallets).values({ userId: guest.id, monthlyRemainingCents: 10000 }).returning(); ids.wallets.push(root.id);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: guest.id, tokenType: 'session', sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' } });
    const id = createId();
    const response = await POST(new Request(`http://app.test/api/ai/page-agents/${agent.id}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletId: root.id, conversationId: id }) }), { params: Promise.resolve({ agentId: agent.id }) });
    expect(response.status).toBe(200);
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0]).toMatchObject({ userId: guest.id, chosenWalletId: root.id });
    expect(await resolveCallSpend({ userId: guest.id, consumerTier: 'pro', target: conversationSpend(drive.id, id), reservationCents: 5 })).toMatchObject({ kind: 'spend', walletId: root.id });
  });

  it('Given an authorized draft choice, should publish the chosen wallet with its row and charge the subsequent first turn to that wallet', async () => {
    const user = await factories.createUser({ subscriptionTier: 'pro' }); ids.users.push(user.id);
    const drive = await factories.createDrive(user.id); ids.drives.push(drive.id);
    const agent = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    const [root] = await db.insert(wallets).values({ userId: user.id, monthlyRemainingCents: 10000 }).returning(); ids.wallets.push(root.id);
    const [child] = await db.insert(wallets).values({ userId: user.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: root.id, monthlyAllowanceCents: 1000, defaultSpendSource: 'drive_wallet' }).returning(); ids.wallets.push(child.id);
    const auth: SessionAuthResult = { userId: user.id, tokenType: 'session', sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0, authentication: { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' } };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    const id = createId();
    const choose = (walletId: string, conversationId = id) => POST(new Request(`http://app.test/api/ai/page-agents/${agent.id}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletId, conversationId }) }), { params: Promise.resolve({ agentId: agent.id }) });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: user.id, tokenType: 'mcp', tokenId: createId(), allowedDriveIds: [drive.id], role: 'user', tokenVersion: 0, adminRoleVersion: 0 });
    const mcp = await choose(root.id);
    expect(mcp.status).toBe(403);
    expect(await mcp.json()).toMatchObject({ code: 'mcp_token_cannot_change_spend_source' });
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toEqual([]);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    expect((await choose(createId())).status).toBe(400);
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toEqual([]);
    expect((await choose(root.id)).status).toBe(200);
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0]).toMatchObject({ userId: user.id, type: 'page', contextId: agent.id, chosenWalletId: root.id });
    expect(await conversationRepository.listConversations(agent.id, 20, 0, user.id)).toEqual([]);
    const gate = await resolveCallSpend({ userId: user.id, consumerTier: 'pro', target: conversationSpend(drive.id, id), reservationCents: 5 });
    expect(gate).toMatchObject({ kind: 'spend', walletId: root.id, fallbackApplied: false });
    if (gate.kind !== 'spend' || !gate.walletId) throw new Error('Chosen source refused');
    expect(await consumeCredits({ aiUsageLogId: createId(), userId: user.id, conversationId: id, costDollars: 0.01, walletId: gate.walletId })).toBe('settled');
    expect((await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id))).map(row => row.walletId)).toEqual([root.id]);
    expect((await db.select().from(wallets).where(eq(wallets.id, child.id)))[0].spentCents).toBe(0);
    expect((await choose(child.id)).status).toBe(409);
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0].chosenWalletId).toBe(root.id);
    await db.update(wallets).set({ monthlyRemainingCents: 0 }).where(eq(wallets.id, root.id));
    expect(await resolveCallSpend({ userId: user.id, consumerTier: 'pro', target: conversationSpend(drive.id, id), reservationCents: 5 })).toMatchObject({ kind: 'refuse', source: 'own_credits', chargeCents: 0 });
    expect((await db.select().from(conversations).where(eq(conversations.id, id)))[0].chosenWalletId).toBe(root.id);
    const other = await factories.createUser(); ids.users.push(other.id);
    const foreignId = createId();
    await db.insert(conversations).values({ id: foreignId, userId: other.id, type: 'page', contextId: agent.id, chosenWalletId: child.id, updatedAt: new Date() });
    expect((await choose(root.id, foreignId)).status).toBe(409);
    expect((await db.select().from(conversations).where(eq(conversations.id, foreignId)))[0]).toMatchObject({ userId: other.id, chosenWalletId: child.id });
  });
});
