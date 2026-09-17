/**
 * Contract tests for /api/cron/reconcile-credits: HMAC gating, and that the
 * missed-grant sweep (MON-2) runs alongside the existing backfill and
 * surfaces its counts in the response and the audit event.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockBackfill, mockReconcileMissedGrants, mockAudit, mockLogError } = vi.hoisted(() => ({
  mockBackfill: vi.fn(),
  mockReconcileMissedGrants: vi.fn(),
  mockAudit: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-backfill', () => ({
  backfillCredits: mockBackfill,
}));

vi.mock('@pagespace/lib/billing/missed-grant-reconcile', () => ({
  reconcileMissedGrants: mockReconcileMissedGrants,
}));

vi.mock('@/lib/stripe/price-config', () => ({
  getTierFromPrice: vi.fn((priceId: string, amount?: number | null) =>
    priceId === 'price_pro' || amount === 2999 ? 'pro' : 'free'),
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
  return new Request('http://localhost:3000/api/cron/reconcile-credits');
}

describe('/api/cron/reconcile-credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockBackfill.mockResolvedValue({ retried: 0, orphans: 0, expiredHolds: 0 });
    mockReconcileMissedGrants.mockResolvedValue({ reconciled: 0, stillMissing: 0, indeterminate: 0, indeterminateLedgerIds: [], failed: 0 });
  });

  it('returns the auth error and never runs either sweep when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockBackfill).not.toHaveBeenCalled();
    expect(mockReconcileMissedGrants).not.toHaveBeenCalled();
  });

  it('MON-2 runs the missed-grant sweep alongside the backfill and reports its counts', async () => {
    mockBackfill.mockResolvedValue({ retried: 3, orphans: 1, expiredHolds: 2 });
    mockReconcileMissedGrants.mockResolvedValue({ reconciled: 4, stillMissing: 1 });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockReconcileMissedGrants).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      success: true,
      retried: 3,
      orphans: 1,
      expiredHolds: 2,
      missedGrantsReconciled: 4,
      missedGrantsStillMissing: 1,
    });
  });

  it('MON-2 the missed-grant counts are recorded on the audit event', async () => {
    mockReconcileMissedGrants.mockResolvedValue({ reconciled: 2, stillMissing: 0 });

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'reconcile_credits',
        details: expect.objectContaining({ missedGrantsReconciled: 2, missedGrantsStillMissing: 0 }),
      }),
    );
  });

  it('a failure in the missed-grant sweep 500s (never silently swallowed) and does not mark success', async () => {
    mockReconcileMissedGrants.mockRejectedValue(new Error('db boom'));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('MON-2 per-row missed-grant failures make the run non-2xx, are reported, and are NOT audited as a success', async () => {
    mockBackfill.mockResolvedValue({ retried: 1, orphans: 0, expiredHolds: 0 });
    mockReconcileMissedGrants.mockResolvedValue({ reconciled: 1, stillMissing: 2, failed: 3 });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      missedGrantsReconciled: 1,
      missedGrantsStillMissing: 2,
      missedGrantsFailed: 3,
    });
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('MON-2 indeterminate rows are reported in the response and the audit (a 200: they need a human, not a retry)', async () => {
    mockReconcileMissedGrants.mockResolvedValue({
      reconciled: 0, stillMissing: 1, indeterminate: 2, indeterminateLedgerIds: ['led_a', 'led_b'], failed: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ missedGrantsIndeterminate: 2 });
    // Paid-but-ungranted until a human acts: as loud as the failure path, with the ledger ids.
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('indeterminate'),
      undefined,
      expect.objectContaining({ indeterminateLedgerIds: ['led_a', 'led_b'] }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ missedGrantsIndeterminate: 2 }) }),
    );
  });

  it('MON-2 a clean run reports zero failures with a 200', async () => {
    mockReconcileMissedGrants.mockResolvedValue({
      reconciled: 1, stillMissing: 0, indeterminate: 0, indeterminateLedgerIds: [], failed: 0,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockLogError).not.toHaveBeenCalled();
    expect(body).toMatchObject({ success: true, missedGrantsFailed: 0 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ missedGrantsFailed: 0 }) }),
    );
  });

  it('MON-2 the sweep resolves tiers through the live Stripe price map, not the users cache', async () => {
    await GET(makeRequest());

    expect(mockReconcileMissedGrants).toHaveBeenCalledWith({ priceTier: expect.any(Function) });
    const { priceTier } = mockReconcileMissedGrants.mock.calls[0][0] as {
      priceTier: (id: string, amountCents?: number | null) => string;
    };
    expect(priceTier('price_pro')).toBe('pro');
    expect(priceTier('price_unknown', 1234)).toBe('free');
    // The invoice amount reaches getTierFromPrice's legacy-amount fallback.
    expect(priceTier('price_legacy_unmapped', 2999)).toBe('pro');
  });
});
