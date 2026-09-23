/**
 * HTTP surface of the account wallet routes (Spec UI-10, SPEND-2, SPEND-3, X-1). The service
 * behaviour (what each person lists, which wallets a conversation may store, owner-only) is
 * proven against Postgres in drive-wallet-service.integration.test.ts; these pin what the
 * routes add: authentication, the refusal of drive-scoped tokens on account-wide reads, body
 * validation, and the `?driveId=` context for a global conversation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/lib/services/drive-wallet-service', () => ({
  listMyWallets: vi.fn(),
  setPersonalDefaultSource: vi.fn(),
  getConversationSpend: vi.fn(),
  setConversationSpend: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
  isMCPAuthResult: (r: { tokenType?: string }) => r.tokenType === 'mcp',
  getAllowedDriveIds: (r: { allowedDriveIds?: string[] }) => r.allowedDriveIds ?? [],
  checkMCPDriveScope: () => null,
}));

import { GET as LIST } from '../route';
import { PUT as SET_DEFAULT } from '../default/route';
import { GET as GET_SOURCE, PUT as SET_SOURCE } from '../conversations/[conversationId]/route';
import { listMyWallets, setPersonalDefaultSource, getConversationSpend, setConversationSpend } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions } from '@/lib/auth';

const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 's-1', role: 'user', adminRoleVersion: 0,
});
const token = (userId: string, allowedDriveIds: string[]) =>
  ({ userId, tokenType: 'mcp', allowedDriveIds }) as unknown as MCPAuthResult;

const req = (method: string, url: string, body?: unknown) =>
  new Request(`https://example.com${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const myWallets = {
  personal: { walletId: 'w-marcus', remainingCents: 5_000, defaultSpendSource: null },
  driveWallets: [{ driveId: 'd-product', walletId: 'w-product', status: 'active', remainingCents: 116_442 }],
  seats: [{ orgId: 'o-northwind', walletId: 'w-pool' }],
  funds: { driveWallets: [], pools: [], donations: [] },
};

const conv = { params: Promise.resolve({ conversationId: 'c-1' }) };
const sourceRead = {
  ok: true as const,
  conversationId: 'c-1',
  driveId: 'd-product',
  chosenWalletId: 'w-pool',
  options: [{ source: 'seat_allowance' as const, walletId: 'w-pool' }],
  resolved: { kind: 'spend' as const, source: 'seat_allowance' as const, walletId: 'w-pool', fallbackApplied: false, fallbackFrom: null, entitlementTier: 'business' as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('u-marcus'));
});

describe('GET /api/wallets', () => {
  it('UI-10 (partial) lists what the caller spends from and funds', async () => {
    vi.mocked(listMyWallets).mockResolvedValue(myWallets);
    const res = await LIST(req('GET', '/api/wallets'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(myWallets);
    expect(listMyWallets).toHaveBeenCalledWith('u-marcus', 'session');
  });

  it('X-1 (partial) an unscoped token may list; a drive-scoped token is refused (the list spans drives)', async () => {
    vi.mocked(listMyWallets).mockResolvedValue(myWallets);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', []));
    expect((await LIST(req('GET', '/api/wallets'))).status).toBe(200);
    vi.mocked(listMyWallets).mockClear();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', ['d-product']));
    expect((await LIST(req('GET', '/api/wallets'))).status).toBe(403);
    expect(listMyWallets).not.toHaveBeenCalled();
  });

  it('an authentication failure is returned as is', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never);
    expect((await LIST(req('GET', '/api/wallets'))).status).toBe(401);
  });
});

describe('PUT /api/wallets/default', () => {
  it('SPEND-3 (partial) sets or clears the caller\'s default source; CSRF on a session', async () => {
    vi.mocked(setPersonalDefaultSource).mockResolvedValue({ ok: true, defaultSpendSource: 'own_credits' });
    const res = await SET_DEFAULT(req('PUT', '/api/wallets/default', { source: 'own_credits' }));
    expect(await res.json()).toEqual({ defaultSpendSource: 'own_credits' });
    expect(setPersonalDefaultSource).toHaveBeenCalledWith('u-marcus', 'own_credits', 'session');
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1]).toEqual({ allow: ['session', 'mcp'], requireCSRF: true });
    vi.mocked(setPersonalDefaultSource).mockResolvedValue({ ok: true, defaultSpendSource: null });
    await SET_DEFAULT(req('PUT', '/api/wallets/default', { source: null }));
    expect(setPersonalDefaultSource).toHaveBeenLastCalledWith('u-marcus', null, 'session');
  });

  it('refuses a kind that is not a source, and a missing field', async () => {
    for (const body of [{ source: 'org_pool' }, {}]) {
      expect((await SET_DEFAULT(req('PUT', '/api/wallets/default', body))).status).toBe(400);
    }
    expect(setPersonalDefaultSource).not.toHaveBeenCalled();
  });
});

describe('/api/wallets/conversations/[conversationId]', () => {
  it('SPEND-2 (partial) GET answers the stored choice, the options and what the gate would spend', async () => {
    vi.mocked(getConversationSpend).mockResolvedValue(sourceRead);
    const res = await GET_SOURCE(req('GET', '/api/wallets/conversations/c-1'), conv);
    const { ok: _ok, ...body } = sourceRead;
    expect(await res.json()).toEqual(body);
    expect(getConversationSpend).toHaveBeenCalledWith('u-marcus', 'c-1', null);
  });

  it('SPEND-3 (partial) a global conversation passes ?driveId= as the context for its options', async () => {
    vi.mocked(getConversationSpend).mockResolvedValue(sourceRead);
    await GET_SOURCE(req('GET', '/api/wallets/conversations/c-1?driveId=d-product'), conv);
    expect(getConversationSpend).toHaveBeenCalledWith('u-marcus', 'c-1', 'd-product');
  });

  it('SPEND-3 (partial) PUT stores a wallet or clears it, CSRF on a session; the service\'s refusal is passed on', async () => {
    vi.mocked(setConversationSpend).mockResolvedValue(sourceRead);
    expect((await SET_SOURCE(req('PUT', '/api/wallets/conversations/c-1', { walletId: 'w-pool' }), conv)).status).toBe(200);
    expect(setConversationSpend).toHaveBeenCalledWith('u-marcus', 'c-1', 'w-pool', 'session', null);
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1]).toEqual({ allow: ['session', 'mcp'], requireCSRF: true });

    vi.mocked(setConversationSpend).mockResolvedValue({ ok: false, status: 400, code: 'wallet_not_available', message: 'no' });
    const refused = await SET_SOURCE(req('PUT', '/api/wallets/conversations/c-1', { walletId: 'w-lena' }), conv);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'no', code: 'wallet_not_available' });
  });

  it('SPEND-3 (partial) someone else\'s conversation is the service\'s 404; a bad body is 400', async () => {
    vi.mocked(getConversationSpend).mockResolvedValue({ ok: false, status: 404, code: 'not_found', message: 'Conversation not found' });
    expect((await GET_SOURCE(req('GET', '/api/wallets/conversations/c-1'), conv)).status).toBe(404);
    expect((await SET_SOURCE(req('PUT', '/api/wallets/conversations/c-1', {}), conv)).status).toBe(400);
    expect(setConversationSpend).not.toHaveBeenCalled();
  });

  it('X-1 (partial) a drive-scoped token cannot read a conversation\'s source', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', ['d-product']));
    expect((await GET_SOURCE(req('GET', '/api/wallets/conversations/c-1'), conv)).status).toBe(403);
    expect(getConversationSpend).not.toHaveBeenCalled();
  });
});

describe('[D-OW-26] an MCP/CLI token on the account routes', () => {
  const refusal = { ok: false as const, status: 403 as const, code: 'mcp_token_cannot_change_spend_source', message: 'An access token cannot change what a conversation or account spends from; sign in to change it' };

  it('SPEND-3 (partial) changing a conversation\'s source or the default with a token answers the service\'s typed refusal', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', []));
    vi.mocked(setConversationSpend).mockResolvedValue(refusal);
    vi.mocked(setPersonalDefaultSource).mockResolvedValue(refusal);
    const a = await SET_SOURCE(req('PUT', '/api/wallets/conversations/c-1', { walletId: 'w-pool' }), conv);
    const b = await SET_DEFAULT(req('PUT', '/api/wallets/default', { source: 'own_credits' }));
    for (const res of [a, b]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: refusal.message, code: 'mcp_token_cannot_change_spend_source' });
    }
    expect(setConversationSpend).toHaveBeenCalledWith('u-marcus', 'c-1', 'w-pool', 'mcp', null);
    expect(setPersonalDefaultSource).toHaveBeenCalledWith('u-marcus', 'own_credits', 'mcp');
  });

  it('SPEND-9 (partial) listing with an unscoped token names the token credential (the service drops pool balances)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token('u-marcus', []));
    vi.mocked(listMyWallets).mockResolvedValue(myWallets);
    await LIST(req('GET', '/api/wallets'));
    expect(listMyWallets).toHaveBeenCalledWith('u-marcus', 'mcp');
  });
});
