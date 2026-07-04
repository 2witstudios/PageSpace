/**
 * POST /api/oauth/device_authorization/decision (task
 * mwexjazwha2uhw5bmvc9a7kw). CSRF-protected approve/deny for the /activate
 * screen: session + CSRF gate, per-session/IP rate limiting, code
 * normalization, and single-settlement passthrough from
 * `decideDeviceApproval` (task 4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: unknown) => !!result && typeof result === 'object' && 'error' in (result as object),
  getClientIP: vi.fn().mockReturnValue('203.0.113.7'),
}));

const checkDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => checkDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300_000, progressiveDelay: false } },
}));

const recordDeviceApproval = vi.fn();
const verifyDeviceUserCode = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  recordDeviceApproval: (...args: unknown[]) => recordDeviceApproval(...args),
  verifyDeviceUserCode: (...args: unknown[]) => verifyDeviceUserCode(...args),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const getDriveAccess = vi.fn();
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: (...args: unknown[]) => getDriveAccess(...args),
}));

const getMemberCustomRoleId = vi.fn();
const customRoleBelongsToDrive = vi.fn();
vi.mock('@pagespace/lib/permissions/membership-queries', () => ({
  getMemberCustomRoleId: (...args: unknown[]) => getMemberCustomRoleId(...args),
  customRoleBelongsToDrive: (...args: unknown[]) => customRoleBelongsToDrive(...args),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';

const AUTHENTICATED = {
  tokenType: 'session',
  userId: 'user-1',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  sessionId: 'sess-1',
};

function decisionRequest(body: unknown): Request {
  return new Request('http://web.local/api/oauth/device_authorization/decision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ALLOWED = { allowed: true, attemptsRemaining: 9 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(AUTHENTICATED as never);
  checkDistributedRateLimit.mockResolvedValue(ALLOWED);
  // Default: the presented user code isn't found by the read-only scope
  // lookup — most tests below exercise deny/rate-limit/not-found paths that
  // never need it, and recordDeviceApproval independently re-validates.
  verifyDeviceUserCode.mockResolvedValue({ outcome: 'not_found' });
  getDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' });
  getMemberCustomRoleId.mockResolvedValue(null);
  customRoleBelongsToDrive.mockResolvedValue(true);
});

describe('POST /api/oauth/device_authorization/decision — CSRF/session gate', () => {
  it('rejects when CSRF/session auth fails, never records a decision', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }),
    } as never);

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(403);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('requires requireCSRF: true on the authentication call', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCSRF: true }),
    );
  });
});

describe('POST /api/oauth/device_authorization/decision — brute-force rate limiting', () => {
  it('blocks when the per-IP limit is exceeded, never recording a decision', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-decide:ip:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(429);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('blocks when the per-session limit is exceeded, never recording a decision', async () => {
    checkDistributedRateLimit.mockImplementation(async (key: string) =>
      key.startsWith('oauth-device-decide:session:') ? { allowed: false, retryAfter: 300 } : ALLOWED,
    );

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(429);
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization/decision — code normalization', () => {
  it('normalizes case and hyphens before recording the decision', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    await POST(decisionRequest({ userCode: 'abcd-efgh', action: 'approve' }) as never);

    expect(recordDeviceApproval).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCDEFGH' }));
  });
});

describe('POST /api/oauth/device_authorization/decision — outcomes', () => {
  it('approve → { ok: true, action: "approved" }', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'approved' });
  });

  it('deny → { ok: true, action: "denied" } (a legitimate outcome, not an error)', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'denied' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'deny' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'denied' });
  });

  it('unknown code → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'not_found' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('already-settled code (single-settlement) → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({
      outcome: 'invalid',
      decision: { status: 'already_settled', existingStatus: 'approved' },
    });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('expired code → invalid_code', async () => {
    recordDeviceApproval.mockResolvedValue({ outcome: 'invalid', decision: { status: 'expired' } });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('invalid action value → invalid_request', async () => {
    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'destroy' }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });
});

describe('POST /api/oauth/device_authorization/decision — P1b: grant-authority check before approval', () => {
  it('rejects approving a scope the user cannot grant (e.g. drive:admin without admin/owner authority), never recording approval', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['drive:abc12345:admin'] });
    getDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('rejects approving a drive the user has no access to at all', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['drive:abc12345'] });
    getDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: false, role: null });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_scope' });
    expect(recordDeviceApproval).not.toHaveBeenCalled();
  });

  it('allows approving a scope the user has authority to grant', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['drive:abc12345:member'] });
    getDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' });
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'approved' });
    expect(recordDeviceApproval).toHaveBeenCalled();
  });

  it('does not run the authority check for a deny decision', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['drive:abc12345:admin'] });
    getDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: false, role: null });
    recordDeviceApproval.mockResolvedValue({ outcome: 'denied' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'deny' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'denied' });
    expect(recordDeviceApproval).toHaveBeenCalled();
  });
});
