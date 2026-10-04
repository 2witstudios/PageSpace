/**
 * Contract tests for /api/cron/reset-wallet-allocations: HMAC gating, the period sweep
 * (comped personal roots, then child allocations) runs with the current time, its counts
 * reach the response and the audit event, and a failed wallet of either kind makes the run
 * a 500; after the resets, member-cap-parked apps are released and a failed release is a 500 too.
 * The resets themselves (D-OW-12, exactly once) are tested against Postgres in
 * packages/lib/src/billing/__tests__/wallet-funding.integration.test.ts and
 * personal-root-roll.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReset, mockUnpark, mockReattribute, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockReset: vi.fn(),
  mockUnpark: vi.fn(),
  mockReattribute: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/wallet-funding-shell', () => ({
  resetDuePeriods: mockReset,
}));

vi.mock('@pagespace/lib/services/app-hosting/app-unpark', () => ({
  releaseMemberCapParks: mockUnpark,
}));

vi.mock('@pagespace/lib/organizations/creator-reattribution', () => ({
  reattributeRemovedCreators: mockReattribute,
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
const REATTRIBUTED = { outcome: 'swept', examined: 3, reattributed: 1, failed: 0 };
const UNPARK = { outcome: 'swept', examined: 2, unparked: 1, stillCapped: 1, policyHeld: 0, failed: 0 };

describe('/api/cron/reset-wallet-allocations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReset.mockResolvedValue({ roots: ROOTS, allocations: { scanned: 4, reset: 2, failed: 0 } });
    mockUnpark.mockResolvedValue(UNPARK);
    mockReattribute.mockResolvedValue(REATTRIBUTED);
  });

  it('refuses an unsigned request without touching a wallet', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockUnpark).not.toHaveBeenCalled();
  });

  it('WAL-3 (partial) runs the period sweep now — comped roots, then allocations — and reports and audits both counts', async () => {
    const before = Date.now();
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, scanned: 4, reset: 2, failed: 0, roots: ROOTS, reattributed: REATTRIBUTED, appUnpark: UNPARK });
    const now: Date = mockReset.mock.calls[0][0].now;
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'reset_wallet_allocations',
      details: { scanned: 4, reset: 2, failed: 0, roots: ROOTS, reattributed: REATTRIBUTED, appUnpark: UNPARK },
    }));
  });

  it('WAL-2 (partial) releases member-cap-parked apps AFTER the periods roll, so a refill this tick un-parks this tick', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(mockUnpark).toHaveBeenCalledTimes(1);
    expect(mockUnpark.mock.invocationCallOrder[0]).toBeGreaterThan(mockReset.mock.invocationCallOrder[0]);
  });

  it('WAL-2 (partial) re-attributes removed creators\' envs and apps after the periods roll and BEFORE the un-park, so an app parked on a removed creator\'s cap is judged against the lead\'s', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const [reset, reattribute, unpark] = [mockReset, mockReattribute, mockUnpark].map((m) => m.mock.invocationCallOrder[0]);
    expect(reattribute).toBeGreaterThan(reset);
    expect(unpark).toBeGreaterThan(reattribute);
  });

  it('a failed re-attribution makes the run a 500', async () => {
    mockReattribute.mockResolvedValue({ ...REATTRIBUTED, failed: 1 });
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
  });

  it('a parked app that failed to release makes the run a 500', async () => {
    mockUnpark.mockResolvedValue({ ...UNPARK, failed: 1 });
    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
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
