/**
 * The admin org-gift route (SEAT-8): admin-only, validates the body, hands the org id from
 * the PATH (never a subscription id from the body) to the lib shell, maps refusals to
 * statuses, and writes the admin audit trail with the reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const giftOrgSubscription = vi.fn();
vi.mock('@pagespace/lib/billing/org-gift', () => ({ giftOrgSubscription: (...args: unknown[]) => giftOrgSubscription(...args) }));

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: (...args: unknown[]) => auditRequest(...args) }));

const port = { createCoupon: vi.fn(), updateSubscription: vi.fn() };
vi.mock('@/lib/stripe/org-gift-port', () => ({ orgGiftStripe: () => port }));

import { POST } from '../route';

const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const post = (body: unknown) =>
  new NextRequest('https://admin.test/api/admin/orgs/org_1/gift-subscription', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('POST /api/admin/orgs/[orgId]/gift-subscription', () => {
  beforeEach(() => {
    giftOrgSubscription.mockReset();
    auditRequest.mockReset();
  });

  it('SEAT-8 (partial) gifts the org named in the path through the lib shell and the admin Stripe port, ignoring any subscription id in the body, and audits the reason', async () => {
    giftOrgSubscription.mockResolvedValue({ kind: 'gifted', subscriptionId: 'sub_org', couponId: 'GIFT_ORG_sub_org', status: 'active', restoresNow: false });
    const res = await POST(post({ reason: 'Design partner', subscriptionId: 'sub_attacker' }), ctx('org_1'));
    expect(res.status).toBe(200);
    expect(giftOrgSubscription).toHaveBeenCalledWith({ orgId: 'org_1', adminUserId: 'admin-1', reason: 'Design partner' }, port);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      userId: 'admin-1',
      resourceType: 'organization',
      resourceId: 'org_1',
      details: expect.objectContaining({ source: 'admin', action: 'gift_org_subscription', reason: 'Design partner', subscriptionId: 'sub_org' }),
    }));
    expect(await res.json()).toMatchObject({ success: true, subscriptionId: 'sub_org' });
  });

  it('requires a non-empty reason', async () => {
    const res = await POST(post({ reason: '  ' }), ctx('org_1'));
    expect(res.status).toBe(400);
    expect(giftOrgSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['org_not_found', 404],
    ['billing_disabled', 404],
    ['self_gift', 400],
    ['no_subscription', 409],
    ['awaiting_first_payment', 409],
    ['already_gifted', 409],
  ])('maps a %s refusal to %i and audits nothing', async (reason, status) => {
    giftOrgSubscription.mockResolvedValue({ kind: 'refused', reason });
    const res = await POST(post({ reason: 'x' }), ctx('org_1'));
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(reason);
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('a Stripe failure is a 400 with a friendly message, never a gift', async () => {
    const { Stripe } = await import('@/lib/stripe');
    giftOrgSubscription.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ message: 'No such coupon', type: 'invalid_request_error' }));
    const res = await POST(post({ reason: 'x' }), ctx('org_1'));
    expect(res.status).toBe(400);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});
