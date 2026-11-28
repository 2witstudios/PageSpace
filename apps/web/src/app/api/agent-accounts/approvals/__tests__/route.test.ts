/**
 * L2·G2 — /api/agent-accounts/approvals: a person approves ONE exact request
 * from their own authenticated SESSION (ADR 0004 §4.3: never from model text).
 * Pinned: the session id recorded is the caller's; a non-session principal is
 * refused; a digest that is not a SHA3-256 hex never reaches the authority.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthority = vi.hoisted(() => ({ approveRequest: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in result),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, security: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/agent-accounts/account-authority-client', () => ({ getAccountAuthority: () => mockAuthority }));
const mockConsumeStepUp = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/auth/step-up-service', () => ({ consumeStepUpGrant: mockConsumeStepUp }));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const DIGEST = 'a'.repeat(64);
const request = (payload: unknown) => new Request('http://localhost/api/agent-accounts/approvals', { method: 'POST', body: JSON.stringify(payload) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'user_1', tokenVersion: 0, tokenType: 'session' as const, sessionId: 'sess_live', role: 'user' as const, adminRoleVersion: 0 });
});

describe('POST /api/agent-accounts/approvals', () => {
  it('given a session and a digest, should record the approval under that session and answer 201', async () => {
    mockAuthority.approveRequest.mockResolvedValue({ ok: true, approvalId: 'appr_1', expiresAt: 5 });
    const response = await POST(request({ accountId: 'acct_1', requestDigest: DIGEST }));
    const actual = { status: response.status, call: mockAuthority.approveRequest.mock.calls[0]?.[0] };
    const expected = { status: 201, call: { actor: credentialActor('user_1', null), sessionId: 'sess_live', accountId: 'acct_1', requestDigest: DIGEST, stepUp: null } };
    expect(actual).toEqual(expected);
  });

  it('given a principal that is not a session, should refuse 403 without approving', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: 'user_1', tokenVersion: 0, tokenType: 'mcp' as const, role: 'user' as const, adminRoleVersion: 0 } as never);
    const response = await POST(request({ accountId: 'acct_1', requestDigest: DIGEST }));
    const actual = { status: response.status, called: mockAuthority.approveRequest.mock.calls.length };
    const expected = { status: 403, called: 0 };
    expect(actual).toEqual(expected);
  });

  it('given a digest that is not 64 hex characters, should answer 400 without approving', async () => {
    const response = await POST(request({ accountId: 'acct_1', requestDigest: 'not-a-digest' }));
    const actual = { status: response.status, called: mockAuthority.approveRequest.mock.calls.length };
    const expected = { status: 400, called: 0 };
    expect(actual).toEqual(expected);
  });

  it('given an account the approver may not use, should answer 404', async () => {
    mockAuthority.approveRequest.mockResolvedValue({ ok: false, reason: 'account_unavailable' });
    const response = await POST(request({ accountId: 'acct_x', requestDigest: DIGEST }));
    const actual = response.status;
    const expected = 404;
    expect(actual).toEqual(expected);
  });

  it('given a step-up token for a privileged request, should bind it to this account AND digest, and refuse one that does not verify', async () => {
    mockAuthority.approveRequest.mockResolvedValue({ ok: true, approvalId: 'appr_2', expiresAt: 5 });
    mockConsumeStepUp.mockResolvedValueOnce({ ok: false, error: { code: 'STEP_UP_REQUIRED' } }).mockResolvedValueOnce({ ok: true, authentication: {} });
    const refused = await POST(request({ accountId: 'acct_1', requestDigest: DIGEST, stepUpToken: 'bad' }));
    const accepted = await POST(request({ accountId: 'acct_1', requestDigest: DIGEST, stepUpToken: 'good-token' }));
    const actual = {
      refused: refused.status,
      accepted: accepted.status,
      binding: mockConsumeStepUp.mock.calls[1]?.[0]?.actionBinding,
      proof: /^stepup:[0-9a-f]{32}$/.test((mockAuthority.approveRequest.mock.calls[0]?.[0]?.stepUp as { challengeId: string }).challengeId),
      calls: mockAuthority.approveRequest.mock.calls.length,
    };
    expect(actual).toEqual({ refused: 401, accepted: 201, binding: { action: 'agent_account_approve', accountId: 'acct_1', requestDigest: DIGEST }, proof: true, calls: 1 });
  });
});
