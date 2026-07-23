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

const consumeStepUpGrant = vi.fn();
vi.mock('@pagespace/lib/auth/step-up-service', () => ({
  consumeStepUpGrant: (...args: unknown[]) => consumeStepUpGrant(...args),
}));

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
  consumeStepUpGrant.mockResolvedValue({ ok: true });
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

  it('allows approving a device code that requested NO scope at all (vacuous authority pass, matching device_authorization/route.ts allowing an empty scope) — regression guard', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: [] });
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'approved' });
    expect(recordDeviceApproval).toHaveBeenCalled();
    // Nothing to authorize, so no drive-access lookups should even run.
    expect(getDriveAccess).not.toHaveBeenCalled();
  });

  it('allows approving a scope the user has authority to grant', async () => {
    verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes: ['drive:abc12345:member'] });
    getDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' });
  consumeStepUpGrant.mockResolvedValue({ ok: true });
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


/**
 * The device flow can now redeem key-shaped grants, so the escalating subset
 * must carry the same second factor the browser consent screen demands for
 * every consent — otherwise `--device` would be a way to mint a key with
 * strictly less proof of presence. Plain logins keep their no-step-up path so
 * `login --device` is unchanged.
 *
 * `isCredentialEscalatingGrant` (packages/lib/.../scopes.ts) is the single
 * predicate behind both this gate and the /activate screen's decision to RUN
 * the ceremony; these cases pin this half of it.
 */
describe('POST /api/oauth/device_authorization/decision — step-up gate on credential-escalating grants', () => {
  const ESCALATING: ReadonlyArray<readonly [string, string[]]> = [
    ['a mint grant', ['drive:drv1:member', 'name:remote-key', 'offline_access']],
    ['a re-scope grant', ['update_key:tok1', 'drive:drv1:member']],
    ['an activation grant', ['activate_key:tok1']],
  ];

  for (const [label, scopes] of ESCALATING) {
    it(`refuses ${label} approved without a step-up token`, async () => {
      verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes });

      const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'step_up_required' });
      expect(recordDeviceApproval).not.toHaveBeenCalled();
    });

    it(`refuses ${label} when the step-up grant does not verify`, async () => {
      verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes });
      consumeStepUpGrant.mockResolvedValue({ ok: false, error: { code: 'STEP_UP_REQUIRED' } });

      const res = await POST(
        decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve', stepUpToken: 'stale-grant' }) as never,
      );

      expect(res.status).toBe(401);
      expect(recordDeviceApproval).not.toHaveBeenCalled();
    });

    it(`binds the step-up grant to this exact code and scope for ${label}`, async () => {
      verifyDeviceUserCode.mockResolvedValue({ outcome: 'ok', clientId: 'pagespace-cli', scopes });
      recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

      await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve', stepUpToken: 'grant' }) as never);

      // Bound to the user code AND the scope string, so a grant obtained for
      // one device approval cannot be replayed against another.
      expect(consumeStepUpGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          token: 'grant',
          actionBinding: { userCode: 'ABCDEFGH', scope: scopes.join(' ') },
        }),
      );
    });
  }

  it('does NOT require step-up for a plain login grant, leaving `login --device` unchanged', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['manage_keys', 'offline_access'],
    });
    recordDeviceApproval.mockResolvedValue({ outcome: 'approved' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'approve' }) as never);

    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(recordDeviceApproval).toHaveBeenCalled();
  });

  it('never requires step-up to DENY, however escalating the grant', async () => {
    verifyDeviceUserCode.mockResolvedValue({
      outcome: 'ok',
      clientId: 'pagespace-cli',
      scopes: ['drive:drv1:member', 'name:k', 'offline_access'],
    });
    recordDeviceApproval.mockResolvedValue({ outcome: 'denied' });

    const res = await POST(decisionRequest({ userCode: 'ABCD-EFGH', action: 'deny' }) as never);

    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });
});
