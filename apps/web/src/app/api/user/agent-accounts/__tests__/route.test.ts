/**
 * L2·G2 — /api/user/agent-accounts. The route is a thin adapter over the
 * account authority: session auth (+CSRF on writes), body validation, status
 * mapping, audit. Pinned here: the API key a person submits is handed to the
 * authority and NEVER appears in any response (canary by value); an
 * unconfigured deployment answers without touching the authority; refusals
 * name a reason, never a value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthority = vi.hoisted(() => ({ createAccount: vi.fn(), listAccounts: vi.fn(), revokeAccount: vi.fn(), requestOperation: vi.fn(), approveRequest: vi.fn() }));
const mockGetAuthority = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in result),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, security: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/agent-accounts/account-authority-client', () => ({ getAccountAuthority: mockGetAuthority }));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const CANARY = 'sk_canary_route_7f3a9c1e5b2d4f6a';
const safeAccount = { id: 'acct_1', kind: 'api_key', name: 'Weather', ownerKind: 'user', providerSlug: null, allowedOrigins: ['https://api.weather.example:443'], acknowledgment: 'dedicated_agent_account', status: 'active', upstreamRevocation: null, lastUsedAt: null, createdAt: 1, revokedAt: null };
const body = { name: 'Weather', allowedOrigins: ['https://api.weather.example'], ownership: 'dedicated', acknowledged: false, apiKey: CANARY, placement: { in: 'header', name: 'X-Api-Key' }, allowGenericRequests: false };
const post = (payload: unknown) => new Request('http://localhost/api/user/agent-accounts', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'user_1', tokenVersion: 0, tokenType: 'session' as const, sessionId: 'sess_1', role: 'user' as const, adminRoleVersion: 0 });
  mockGetAuthority.mockReturnValue(mockAuthority);
});

describe('POST /api/user/agent-accounts', () => {
  it('given a valid body, should create for the caller as owner and answer 201 with the SafeAccount — the key appears nowhere in the response', async () => {
    mockAuthority.createAccount.mockResolvedValue({ ok: true, account: safeAccount });
    const response = await POST(post(body));
    const text = await response.text();
    const actual = { status: response.status, leaked: text.includes(CANARY), call: mockAuthority.createAccount.mock.calls[0]?.[0]?.owner, keyHanded: mockAuthority.createAccount.mock.calls[0]?.[0]?.input?.apiKey === CANARY, audited: vi.mocked(auditRequest).mock.calls.length };
    const expected = { status: 201, leaked: false, call: { kind: 'user' }, keyHanded: true, audited: 1 };
    expect(actual).toEqual(expected);
  });

  it('given an authority refusal, should answer its status with the reason word and no value', async () => {
    const cases: readonly [string, number][] = [['acknowledgment_required', 400], ['plane_unavailable', 503], ['forbidden', 403], ['kind_not_supported', 400]];
    const actual: [number, string][] = [];
    for (const [reason] of cases) {
      mockAuthority.createAccount.mockResolvedValueOnce({ ok: false, reason });
      const response = await POST(post(body));
      const text = await response.text();
      actual.push([response.status, text.includes(CANARY) ? 'leaked' : (JSON.parse(text) as { error: string }).error]);
    }
    const expected = cases.map(([reason, status]) => [status, reason]);
    expect(actual).toEqual(expected);
  });

  it('given a malformed body or an unknown field, should answer 400 without calling the authority', async () => {
    const responses = [await POST(post({ ...body, apiKey: '' })), await POST(post({ ...body, extra: CANARY }))];
    const actual = { statuses: responses.map((response) => response.status), called: mockAuthority.createAccount.mock.calls.length };
    const expected = { statuses: [400, 400], called: 0 };
    expect(actual).toEqual(expected);
  });

  it('given an unconfigured deployment, should answer 503 not_configured', async () => {
    mockGetAuthority.mockReturnValue(null);
    const response = await POST(post(body));
    const actual = { status: response.status, body: await response.json() };
    const expected = { status: 503, body: { error: 'not_configured' } };
    expect(actual).toEqual(expected);
  });
});

describe('GET /api/user/agent-accounts', () => {
  it('given a configured deployment, should list the caller’s own accounts', async () => {
    mockAuthority.listAccounts.mockResolvedValue([safeAccount]);
    const response = await GET(new Request('http://localhost/api/user/agent-accounts'));
    const actual = { body: await response.json(), owner: mockAuthority.listAccounts.mock.calls[0]?.[0] };
    const expected = { body: { configured: true, accounts: [safeAccount] }, owner: { actorUserId: 'user_1', owner: { kind: 'user' } } };
    expect(actual).toEqual(expected);
  });

  it('given an unconfigured deployment, should report configured false', async () => {
    mockGetAuthority.mockReturnValue(null);
    const response = await GET(new Request('http://localhost/api/user/agent-accounts'));
    const actual = await response.json();
    const expected = { configured: false, accounts: [] };
    expect(actual).toEqual(expected);
  });
});
