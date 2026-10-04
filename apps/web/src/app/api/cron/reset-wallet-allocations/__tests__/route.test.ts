/**
 * Contract tests for /api/cron/reset-wallet-allocations: HMAC gating, the period sweep
 * (comped personal roots, then child allocations) runs with the current time, its counts
 * reach the response and the audit event, and a failed wallet of either kind makes the run
 * a 500. The resets themselves (D-OW-12, exactly once) are tested against Postgres in
 * packages/lib/src/billing/__tests__/wallet-funding.integration.test.ts and
 * personal-root-roll.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReset, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockReset: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/wallet-funding-shell', () => ({
  resetDuePeriods: mockReset,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { system: { error: mockLogError } },
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
  return new Request('http://localhost:3000/api/cron/reset-wallet-allocations');
}

const ROOTS = { scanned: 1, reset: 1, failed: 0 };

describe('/api/cron/reset-wallet-allocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReset.mockResolvedValue({ roots: ROOTS, allocations: { scanned: 4, reset: 2, failed: 0 } });
  });

  it('refuses an unsigned request without touching a wallet', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('WAL-3 (partial) runs the period sweep now — comped roots, then allocations — and reports and audits both counts', async () => {
    const before = Date.now();
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, scanned: 4, reset: 2, failed: 0, roots: ROOTS });
    const now: Date = mockReset.mock.calls[0][0].now;
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'reset_wallet_allocations',
      details: { scanned: 4, reset: 2, failed: 0, roots: ROOTS },
    }));
  });

  it('a personal root that failed to roll makes the run a 500', async () => {
    mockReset.mockResolvedValue({ roots: { scanned: 1, reset: 0, failed: 1 }, allocations: { scanned: 4, reset: 2, failed: 0 } });
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('a wallet that failed to reset makes the run a 500', async () => {
    mockReset.mockResolvedValue({ roots: ROOTS, allocations: { scanned: 4, reset: 1, failed: 1 } });
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('a thrown sweep is a 500, not a 200', async () => {
    mockReset.mockRejectedValue(new Error('db down'));
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
  });
});
