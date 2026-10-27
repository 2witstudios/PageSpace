/**
 * POST /api/orgs/[orgId]/billing/subscription (Spec SEAT-1, SEAT-6, SEAT-8, SEAT-9 recovery). The shell
 * is faked; authorization is NOT: the real requireOrgRole runs over a faked membership
 * lookup, so a route that skipped it or asked for the wrong role fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ billingEnabled: true }));

// The org sign-in policy (SEC-2/3) has its own suites; here every credential meets it.
vi.mock('@pagespace/lib/permissions/actor-authentication', () => ({
  checkActorOrgAuthentication: vi.fn(async () => ({ allowed: true })),
  drivePolicyOrgId: vi.fn(async () => null),
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: () => flags.billingEnabled }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@/lib/org-billing/org-subscription', async () => {
  class OrgBillingError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    OrgBillingError,
    provisionOrgSubscription: vi.fn(),
    orgSubscriptionSummary: (l: { status: string; currentPeriodEnd: Date | null; extraSeatQuantity: number }) => ({
      status: l.status,
      currentPeriodEnd: l.currentPeriodEnd?.toISOString() ?? null,
      extraSeatQuantity: l.extraSeatQuantity,
    }),
  };
});

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { provisionOrgSubscription, OrgBillingError } from '@/lib/org-billing/org-subscription';
import { POST } from '../route';

const ORG_ID = 'org_northwind';
const PERIOD_END = new Date('2026-11-10T12:00:00.000Z');
const linkage = {
  orgId: ORG_ID,
  stripeCustomerId: 'cus_hidden',
  stripeSubscriptionId: 'sub_hidden',
  stripeBaseItemId: 'si_base_hidden',
  stripeSeatItemId: 'si_seat_hidden',
  extraSeatQuantity: 0,
  status: 'incomplete',
  currentPeriodEnd: PERIOD_END,
};
const PAY = { kind: 'confirm_payment' as const, clientSecret: 'pi_123_secret_abc' };

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess',
  role: 'user',
  adminRoleVersion: 0,
});
const call = () =>
  POST(new Request(`https://example.test/api/orgs/${ORG_ID}/billing/subscription`, { method: 'POST' }), {
    params: Promise.resolve({ orgId: ORG_ID }),
  });

function as(role: OrgRole | null) {
  vi.mocked(findMembershipRole).mockResolvedValue(role);
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.billingEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(provisionOrgSubscription).mockResolvedValue({ result: { kind: 'created', linkage }, payment: PAY, activation: 'payment_required' });
});

describe('POST /api/orgs/[orgId]/billing/subscription', () => {
  it('SEAT-1 (partial) SEAT-6 (partial) SEAT-8 (partial) an Owner or Admin provisions the org subscription and gets its state plus the client secret to pay its open invoice, never a Stripe customer or subscription id', async () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      as(role);
      const res = await call();
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({
        subscription: { status: 'incomplete', currentPeriodEnd: PERIOD_END.toISOString(), extraSeatQuantity: 0 },
        payment: { kind: 'confirm_payment', clientSecret: 'pi_123_secret_abc' },
        activation: 'payment_required',
      });
      expect(JSON.stringify(body)).not.toMatch(/cus_|sub_|si_/);
    }
    expect(provisionOrgSubscription).toHaveBeenCalledWith(ORG_ID);
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceId: ORG_ID, details: expect.objectContaining({ operation: 'provision_org_subscription' }) }),
    );
  });

  it('SEAT-6 (partial) a plain Member or a non-member is refused before any Stripe call', async () => {
    as('MEMBER');
    expect((await call()).status).toBe(403);
    as(null);
    expect((await call()).status).toBe(404);
    expect(provisionOrgSubscription).not.toHaveBeenCalled();
  });

  it('SEAT-1 (partial) a replay on a subscribed org answers 200 with the same subscription; a paid-up org gets no payment step', async () => {
    as('OWNER');
    vi.mocked(provisionOrgSubscription).mockResolvedValue({ result: { kind: 'existing', linkage: { ...linkage, status: 'active' } }, payment: { kind: 'none' }, activation: 'active' });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ payment: { kind: 'none' }, activation: 'active' });
  });

  it('SEAT-9 (partial) an active org whose payment is in but whose funding proof is not recorded yet answers 200 activation funding_pending: nothing to pay, and never reported as active', async () => {
    as('OWNER');
    vi.mocked(provisionOrgSubscription).mockResolvedValue({ result: { kind: 'existing', linkage: { ...linkage, status: 'active' } }, payment: { kind: 'none' }, activation: 'funding_pending' });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ payment: { kind: 'none' }, activation: 'funding_pending' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ activation: 'funding_pending' }) }));
  });

  it('SEAT-6 (partial) is absent where billing is off (onprem, tenant)', async () => {
    as('OWNER');
    flags.billingEnabled = false;
    const billingOff = await call();
    // Billing off answers its own code (UI-7).
    expect([billingOff.status, (await billingOff.json()).code]).toEqual([404, 'billing_unavailable']);
    expect(provisionOrgSubscription).not.toHaveBeenCalled();
  });

  it.each(['manual_collection', 'unfunded_active'])('SEAT-9 (partial) D-OW-44: a subscription PageSpace cannot activate (%s) is a 409 billing_requires_support, never a success', async (reason) => {
    as('OWNER');
    vi.mocked(provisionOrgSubscription).mockRejectedValueOnce(new OrgBillingError('billing_requires_support', `x: ${reason}`));
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('billing_requires_support');
    expect(body).not.toHaveProperty('subscription');
    expect(body).not.toHaveProperty('payment');
    expect(body).not.toHaveProperty('activation');
    expect(JSON.stringify(body)).not.toContain(reason);
  });

  it('a Stripe failure is a retryable 502, unconfigured prices a 503, a vanished org a 404', async () => {
    as('OWNER');
    vi.mocked(provisionOrgSubscription).mockRejectedValueOnce(new Error('Stripe is unavailable'));
    const failed = await call();
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/try again/);
    vi.mocked(provisionOrgSubscription).mockRejectedValueOnce(new OrgBillingError('prices_not_configured', 'x'));
    expect((await call()).status).toBe(503);
    vi.mocked(provisionOrgSubscription).mockRejectedValueOnce(new OrgBillingError('org_not_found', 'x'));
    expect((await call()).status).toBe(404);
  });
});
