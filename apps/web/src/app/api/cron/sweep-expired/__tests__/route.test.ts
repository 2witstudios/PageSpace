/**
 * Contract tests for /api/cron/sweep-expired
 * Verifies security audit logging on successful expiry sweep.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSweep, mockAudit } = vi.hoisted(() => ({
  mockSweep: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  sweepExpiredRevokedJTIs: mockSweep,
}));

vi.mock('@pagespace/lib/server', () => ({
  audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/sweep-expired');
}

describe('/api/cron/sweep-expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockSweep.mockResolvedValue(3);
  });

  it('logs audit event on successful sweep', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.delete',
        userId: 'system',
        resourceType: 'cron_job',
        resourceId: 'sweep_expired',
        details: { revokedServiceTokens: 3 },
      })
    );
  });

  it('returns swept counts in response body', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      swept: { revokedServiceTokens: 3 },
    });
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('does not sweep or audit when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not log audit event when sweep throws', async () => {
    mockSweep.mockRejectedValue(new Error('DB error'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns 500 with error message when sweep throws', async () => {
    mockSweep.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: 'connection refused',
    });
  });
});
