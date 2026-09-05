/**
 * Contract tests for the daemon-facing env-bridge routes: enrollment and the
 * two-step socket token. Mocked at the runtime seam; what these pin is the
 * route's own contract — the opt-in flag, the rate limits, the status each
 * service refusal becomes, and that every refusal is audited.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({ checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({
  enrollLocalEnv: vi.fn(),
  issueEnvChallenge: vi.fn(),
  redeemEnvChallenge: vi.fn(),
}));

import { POST as enroll } from '../enroll/route';
import { GET as challenge, POST as redeem } from '../token/route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { enrollLocalEnv, issueEnvChallenge, redeemEnvChallenge } from '@/lib/drive-envs/drive-envs-runtime';

const ENROLLMENT = 'enr_1';
const enrollBody = { enrollmentId: ENROLLMENT, code: 'ABCDEFGHJKMNPQRSTVWX', machinePublicKey: 'MCowBQYDK2VwAyEA' };
const redeemBody = { enrollmentId: ENROLLMENT, nonce: 'n1', signature: 'c2ln' };

function post(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

const enrollReq = (body: unknown = enrollBody) => post('http://localhost/api/env-bridge/enroll', body);
const redeemReq = (body: unknown = redeemBody) => post('http://localhost/api/env-bridge/token', body);
const challengeReq = (enrollmentId: string | null = ENROLLMENT) =>
  new Request(`http://localhost/api/env-bridge/token${enrollmentId === null ? '' : `?enrollmentId=${enrollmentId}`}`);

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe('the cloud opt-in (invariant 11)', () => {
  it('given LOCAL_ENVS_ENABLED off, every bridge route should answer 404 and touch NOTHING', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    expect((await enroll(enrollReq())).status).toBe(404);
    expect((await challenge(challengeReq())).status).toBe(404);
    expect((await redeem(redeemReq())).status).toBe(404);
    expect(enrollLocalEnv).not.toHaveBeenCalled();
    expect(issueEnvChallenge).not.toHaveBeenCalled();
    expect(redeemEnvChallenge).not.toHaveBeenCalled();
    expect(checkDistributedRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/env-bridge/enroll', () => {
  it('given a valid code and key, should pin and answer 200 with the server key to pin, auditing the pin', async () => {
    vi.mocked(enrollLocalEnv).mockResolvedValue({ ok: true, envId: 'env_1', enrollmentId: ENROLLMENT, serverKeyId: 'k1', serverPublicKey: 'U0VSVkVS' });
    const response = await enroll(enrollReq());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ enrollmentId: ENROLLMENT, envId: 'env_1', serverKeyId: 'k1', serverPublicKey: 'U0VSVkVS' });
    expect(enrollLocalEnv).toHaveBeenCalledWith(enrollBody);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', resourceId: 'env_1' }));
  });

  it.each([
    ['not_found', 404],
    ['revoked', 410],
    ['expired', 410],
    ['used', 409],
    ['already_enrolled', 409],
    ['race', 409],
    ['mismatch', 401],
    ['malformed', 400],
    ['bad_public_key', 400],
  ] as const)('given the service refuses with %s, should answer %i naming the reason and audit the denial', async (reason, status) => {
    vi.mocked(enrollLocalEnv).mockResolvedValue({ ok: false, reason });
    const response = await enroll(enrollReq());
    expect(response.status).toBe(status);
    expect((await json(response)).reason).toBe(reason);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason }) }));
  });

  it('given a malformed body (missing field, extra field, non-JSON), should answer 400 without reaching the service', async () => {
    expect((await enroll(enrollReq({ enrollmentId: ENROLLMENT, code: 'x' }))).status).toBe(400);
    expect((await enroll(enrollReq({ ...enrollBody, isAdmin: true }))).status).toBe(400);
    expect((await enroll(new Request('http://localhost/api/env-bridge/enroll', { method: 'POST', body: 'not json' }))).status).toBe(400);
    expect(enrollLocalEnv).not.toHaveBeenCalled();
  });

  it('given the per-IP limit is hit, should answer 429 with Retry-After, audit it, and not read the body', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30 } as never);
    const response = await enroll(enrollReq());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'security.rate.limited' }));
    expect(enrollLocalEnv).not.toHaveBeenCalled();
  });

  it('given the per-enrollment limit is hit (the IP limit passed), should answer 429 keyed on the enrollment', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: true } as never).mockResolvedValueOnce({ allowed: false, retryAfter: 120 } as never);
    const response = await enroll(enrollReq());
    expect(response.status).toBe(429);
    expect(vi.mocked(checkDistributedRateLimit).mock.calls[1]?.[0]).toBe(`env-bridge-enroll:enrollment:${ENROLLMENT}`);
    expect(enrollLocalEnv).not.toHaveBeenCalled();
  });
});

describe('GET /api/env-bridge/token — the challenge', () => {
  it('given an enrolled machine, should answer the nonce and its expiry', async () => {
    const expiresAt = new Date('2026-09-05T10:01:00.000Z');
    vi.mocked(issueEnvChallenge).mockResolvedValue({ ok: true, nonce: 'n1', expiresAt });
    const response = await challenge(challengeReq());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ nonce: 'n1', expiresAt: expiresAt.toISOString() });
    expect(issueEnvChallenge).toHaveBeenCalledWith({ enrollmentId: ENROLLMENT });
  });

  it('given no enrollmentId, should answer 400 without reaching the service', async () => {
    expect((await challenge(challengeReq(null))).status).toBe(400);
    expect(issueEnvChallenge).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['not_enrolled', 409],
    ['revoked', 410],
  ] as const)('given the service refuses with %s, should answer %i and audit', async (reason, status) => {
    vi.mocked(issueEnvChallenge).mockResolvedValue({ ok: false, reason });
    const response = await challenge(challengeReq());
    expect(response.status).toBe(status);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'authz.access.denied', details: expect.objectContaining({ reason }) }));
  });

  it('given the rate limit is hit, should answer 429', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 10 } as never);
    expect((await challenge(challengeReq())).status).toBe(429);
    expect(issueEnvChallenge).not.toHaveBeenCalled();
  });
});

describe('POST /api/env-bridge/token — the redeem', () => {
  it('given a valid proof, should answer the token, its TTL and the env, auditing the mint', async () => {
    vi.mocked(redeemEnvChallenge).mockResolvedValue({ ok: true, token: 'mcp_tok', expiresInMs: 600_000, envId: 'env_1' });
    const response = await redeem(redeemReq());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ token: 'mcp_tok', expiresInMs: 600_000, envId: 'env_1' });
    expect(redeemEnvChallenge).toHaveBeenCalledWith({ enrollmentId: ENROLLMENT, response: redeemBody });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.token.created', resourceId: 'env_1' }));
  });

  it.each([
    ['not_found', 404],
    ['not_enrolled', 409],
    ['revoked', 410],
    ['no_challenge', 409],
    ['race', 409],
    ['malformed', 400],
    ['wrong_enrollment', 401],
    ['nonce_mismatch', 401],
    ['used', 401],
    ['expired', 401],
    ['bad_signature', 401],
  ] as const)('given the service refuses with %s, should answer %i and audit it as a login failure', async (reason, status) => {
    vi.mocked(redeemEnvChallenge).mockResolvedValue({ ok: false, reason });
    const response = await redeem(redeemReq());
    expect(response.status).toBe(status);
    expect((await json(response)).reason).toBe(reason);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'auth.login.failure', details: expect.objectContaining({ reason }) }));
  });

  it('given a malformed body (missing signature, extra field), should answer 400 without reaching the service', async () => {
    expect((await redeem(redeemReq({ enrollmentId: ENROLLMENT, nonce: 'n1' }))).status).toBe(400);
    expect((await redeem(redeemReq({ ...redeemBody, scopes: ['*'] }))).status).toBe(400);
    expect(redeemEnvChallenge).not.toHaveBeenCalled();
  });

  it('given the per-enrollment limit is hit, should answer 429 and mint nothing', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: true } as never).mockResolvedValueOnce({ allowed: false, retryAfter: 60 } as never);
    expect((await redeem(redeemReq())).status).toBe(429);
    expect(redeemEnvChallenge).not.toHaveBeenCalled();
  });
});
