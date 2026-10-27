/**
 * Contract tests for /api/cron/release-org-seats: HMAC gating, billing-off skip, the sweep runs
 * with the current time and the production Stripe port, counts reach the response and the audit
 * event, and a failed org makes the run a 500. The release rules themselves (period boundary,
 * proration, idempotence, recovery) are proven against Postgres in
 * packages/lib/src/organizations/__tests__/seat-service.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRelease, mockAudit, mockLogError, mockBilling } = vi.hoisted(() => ({
  mockRelease: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
  mockBilling: vi.fn(() => true),
}));

vi.mock('@/lib/auth/cron-auth', () => ({ validateSignedCronRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/seat-service', () => ({ releaseDueSeats: mockRelease }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mockBilling }));
vi.mock('@/lib/org-billing/seat-billing', () => ({ defaultSeatBilling: () => ({ port: true }) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: mockAudit }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { system: { error: mockLogError } } }));
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

const request = () => new Request('http://localhost:3000/api/cron/release-org-seats');

describe('/api/cron/release-org-seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockBilling.mockReturnValue(true);
  });

  it('SEAT-5 (partial) an unsigned request is refused and the sweep never runs', async () => {
    vi.mocked(validateSignedCronRequest).mockReturnValue(new Response('no', { status: 401 }) as never);
    expect((await GET(request())).status).toBe(401);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('SEAT-5 (partial) runs the sweep with the current time and the Stripe port, and returns and audits its counts', async () => {
    mockRelease.mockResolvedValue({ scanned: 3, released: 2, healed: 1, failed: 0 });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, scanned: 3, released: 2, healed: 1, failed: 0 });
    expect(mockRelease).toHaveBeenCalledWith({ now: expect.any(Date) }, { port: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'release_org_seats', details: { scanned: 3, released: 2, healed: 1, failed: 0 } }));
  });

  it('SEAT-5 (partial) an org that failed makes the run a 500 so it pages', async () => {
    mockRelease.mockResolvedValue({ scanned: 2, released: 1, healed: 0, failed: 1 });
    expect((await GET(request())).status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('SEAT-5 (partial) where billing is off (onprem, tenant) nothing is read or written', async () => {
    mockBilling.mockReturnValue(false);
    const res = await GET(request());
    expect(await res.json()).toEqual({ success: true, skipped: 'billing_disabled' });
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
