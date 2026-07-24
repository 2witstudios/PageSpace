/**
 * Contract tests for /api/cron/reconcile-subscription-tiers (#2149).
 * Verifies HMAC gating, audit logging, and that the reconcile result surfaces
 * in the response for the users.subscriptionTier drift-repair cron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReconcile, mockAudit, mockGetTierFromPrice } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockAudit: vi.fn(),
  mockGetTierFromPrice: vi.fn(() => 'pro'),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/subscription-tier-reconcile', () => ({
  reconcileSubscriptionTiers: mockReconcile,
}));

vi.mock('@/lib/stripe', () => ({
  getTierFromPrice: mockGetTierFromPrice,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
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
  return new Request('http://localhost:3000/api/cron/reconcile-subscription-tiers');
}

describe('/api/cron/reconcile-subscription-tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    mockReconcile.mockResolvedValue({
      scanned: 100,
      drifted: 2,
      repaired: 1,
      flaggedOnly: 1,
      details: [
        { userId: 'u1', storedTier: 'founder', expectedTier: 'free', repaired: true, indeterminate: false },
        { userId: 'u2', storedTier: 'pro', expectedTier: 'free', repaired: false, indeterminate: true },
      ],
    });
  });

  it('returns the auth error and never reconciles when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reconciles and emits a data.write audit event with the drift counts', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.write',
        resourceType: 'cron_job',
        resourceId: 'reconcile_subscription_tiers',
        details: expect.objectContaining({ scanned: 100, drifted: 2, repaired: 1, flaggedOnly: 1 }),
      }),
    );
    expect(body).toMatchObject({ success: true, scanned: 100, drifted: 2, repaired: 1, flaggedOnly: 1 });
  });

  it('surfaces indeterminate (unrepaired) drift details in the response for alerting', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: 'u2', indeterminate: true, repaired: false })]),
    );
  });

  it('returns a 500 with the error message when reconcile throws', async () => {
    mockReconcile.mockRejectedValue(new Error('db exploded'));

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: 'db exploded' });
  });

  it('POST delegates to GET', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});
