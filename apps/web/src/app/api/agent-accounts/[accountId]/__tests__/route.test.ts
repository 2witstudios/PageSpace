/**
 * Slice 2 — /api/agent-accounts/[accountId] (permissions) and its bindings /
 * delegations siblings. Thin adapters over the authority. Pinned here: a
 * change with no step-up reaches the authority as `stepUp: null` (it decides
 * whether that is enough); a step-up token that does not verify is refused
 * BEFORE the authority is called, never downgraded to "no step-up"; a verified
 * one becomes a proof that names a digest of the token, never the token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthority = vi.hoisted(() => ({ describeAccount: vi.fn(), updateAccount: vi.fn(), bindAccount: vi.fn(), unbindAccount: vi.fn(), createDelegation: vi.fn(), revokeDelegation: vi.fn() }));
const mockGetAuthority = vi.hoisted(() => vi.fn());
const mockConsumeStepUp = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in result),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, security: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/auth/step-up-service', () => ({ consumeStepUpGrant: mockConsumeStepUp }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ canUserViewPage: vi.fn().mockResolvedValue(true) }));
vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(() => ({ from: () => ({ where: async () => [{ id: 'page_a', title: 'Agent A' }] }) })) } }));
vi.mock('@/lib/agent-accounts/account-authority-client', () => ({ getAccountAuthority: mockGetAuthority }));

import { GET, PATCH } from '../route';
import { POST as BIND } from '../bindings/route';
import { POST as DELEGATE } from '../delegations/route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const STEP_UP_TOKEN = 'ps_stepup_canary_0123456789abcdef';
const settings = {
  account: { id: 'acct_1', kind: 'api_key', name: 'Weather', ownerKind: 'user', providerSlug: null, allowedOrigins: ['https://api.weather.example:443'], acknowledgment: 'dedicated_agent_account', status: 'active', upstreamRevocation: null, lastUsedAt: null, createdAt: 1, revokedAt: null, ready: true },
  autoApprove: null,
  usesThisHour: null,
  bindings: [{ agentPageId: 'page_a', boundByUserId: 'user_1', boundAt: 1 }],
  delegations: [],
  canBind: true,
};
const context = { params: Promise.resolve({ accountId: 'acct_1' }) };
const request = (method: string, url: string, payload?: unknown) => new Request(`http://localhost${url}`, { method, body: payload === undefined ? undefined : JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const edit = { allowedOrigins: ['https://api.weather.example'], autoApprove: { enabled: true, maxUsesPerHour: 10, until: null } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'user_1', tokenVersion: 0, tokenType: 'session' as const, sessionId: 'sess_1', role: 'user' as const, adminRoleVersion: 0 });
  mockGetAuthority.mockReturnValue(mockAuthority);
});

describe('GET /api/agent-accounts/[accountId]', () => {
  it('given a manager, should answer the settings with each bound agent titled', async () => {
    mockAuthority.describeAccount.mockResolvedValue({ ok: true, settings });
    const response = await GET(request('GET', '/api/agent-accounts/acct_1'), context);
    const body = (await response.json()) as { settings: { bindings: { title: string }[] } };
    expect({ status: response.status, titles: body.settings.bindings.map((binding) => binding.title) }).toEqual({ status: 200, titles: ['Agent A'] });
  });

  it('given anyone the authority refuses, should answer 404 account_unavailable', async () => {
    mockAuthority.describeAccount.mockResolvedValue({ ok: false, reason: 'account_unavailable' });
    const response = await GET(request('GET', '/api/agent-accounts/acct_1'), context);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: 'account_unavailable' } });
  });
});

describe('PATCH /api/agent-accounts/[accountId]', () => {
  it('given no step-up token and a widening, should pass stepUp null and answer the authority\'s step_up_required as 401', async () => {
    mockAuthority.updateAccount.mockResolvedValue({ ok: false, reason: 'step_up_required' });
    const response = await PATCH(request('PATCH', '/api/agent-accounts/acct_1', edit), context);
    expect({ status: response.status, body: await response.json(), stepUp: mockAuthority.updateAccount.mock.calls[0]?.[0]?.stepUp, consumed: mockConsumeStepUp.mock.calls.length }).toEqual({ status: 401, body: { error: 'step_up_required' }, stepUp: null, consumed: 0 });
  });

  it('given a step-up token that does not verify, should answer 401 without calling the authority', async () => {
    mockConsumeStepUp.mockResolvedValue({ ok: false, error: { code: 'STEP_UP_REQUIRED' } });
    const response = await PATCH(request('PATCH', '/api/agent-accounts/acct_1', { ...edit, stepUpToken: STEP_UP_TOKEN }), context);
    expect({ status: response.status, called: mockAuthority.updateAccount.mock.calls.length }).toEqual({ status: 401, called: 0 });
  });

  it('given a verified step-up, should bind it to this account and hand the authority a proof naming a digest of the token, never the token', async () => {
    mockConsumeStepUp.mockResolvedValue({ ok: true, authentication: {} });
    mockAuthority.updateAccount.mockResolvedValue({ ok: true, settings });
    const response = await PATCH(request('PATCH', '/api/agent-accounts/acct_1', { ...edit, stepUpToken: STEP_UP_TOKEN }), context);
    const proof = mockAuthority.updateAccount.mock.calls[0]?.[0]?.stepUp as { challengeId: string };
    const actual = {
      status: response.status,
      binding: mockConsumeStepUp.mock.calls[0]?.[0]?.actionBinding,
      proofShape: /^stepup:[0-9a-f]{32}$/.test(proof.challengeId),
      tokenInProof: JSON.stringify(proof).includes(STEP_UP_TOKEN),
      edit: mockAuthority.updateAccount.mock.calls[0]?.[0]?.edit,
    };
    expect(actual).toEqual({ status: 200, binding: { action: 'agent_account_widen', accountId: 'acct_1' }, proofShape: true, tokenInProof: false, edit });
  });

  it('given an unknown field or a cap above 1000, should answer 400 without calling the authority', async () => {
    const responses = [
      await PATCH(request('PATCH', '/api/agent-accounts/acct_1', { ...edit, extra: 1 }), context),
      await PATCH(request('PATCH', '/api/agent-accounts/acct_1', { ...edit, autoApprove: { enabled: true, maxUsesPerHour: 5_000, until: null } }), context),
    ];
    expect({ statuses: responses.map((response) => response.status), called: mockAuthority.updateAccount.mock.calls.length }).toEqual({ statuses: [400, 400], called: 0 });
  });
});

describe('POST bindings / delegations', () => {
  it('given each refusal word, should map it to its status', async () => {
    const cases: readonly [string, number][] = [['page_unavailable', 404], ['not_a_consenter', 403], ['conflict', 409], ['auto_approve_required', 400], ['consent_unavailable', 503]];
    const actual: [number, string][] = [];
    for (const [reason] of cases) {
      mockAuthority.bindAccount.mockResolvedValueOnce({ ok: false, reason });
      const response = await BIND(request('POST', '/api/agent-accounts/acct_1/bindings', { agentPageId: 'page_a' }), context);
      actual.push([response.status, ((await response.json()) as { error: string }).error]);
    }
    expect(actual).toEqual(cases.map(([reason, status]) => [status, reason]));
  });

  it('given a delegation request, should pass the agent, expiry and stepUp through to the authority', async () => {
    mockAuthority.createDelegation.mockResolvedValue({ ok: true, settings });
    const before = Date.now();
    const response = await DELEGATE(request('POST', '/api/agent-accounts/acct_1/delegations', { agentPageId: 'page_a', days: 30 }), context);
    const call = mockAuthority.createDelegation.mock.calls[0]?.[0];
    const expiresAt = call?.expiresAt as number;
    // Computed on the server's clock: 30 days from the request.
    expect({ status: response.status, agentPageId: call?.agentPageId, inWindow: expiresAt >= before + 30 * 86_400_000 && expiresAt <= Date.now() + 30 * 86_400_000, stepUp: call?.stepUp }).toEqual({ status: 200, agentPageId: 'page_a', inWindow: true, stepUp: null });
  });

  it('given more than 90 days, should answer 400 without calling the authority', async () => {
    const response = await DELEGATE(request('POST', '/api/agent-accounts/acct_1/delegations', { agentPageId: 'page_a', days: 91 }), context);
    expect({ status: response.status, called: mockAuthority.createDelegation.mock.calls.length }).toEqual({ status: 400, called: 0 });
  });
});
