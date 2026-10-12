/**
 * The admin org-gift routes (SEAT-8, D-OW-54): admin-only, validate the body, hand the org id
 * from the PATH (never a subscription id from the body) to the lib shell, map refusals to
 * statuses, and write the admin audit trail with the reason. POST gifts for a pinned number of
 * extra seats; DELETE revokes the gift.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const giftOrgSubscription = vi.fn();
const ungiftOrgSubscription = vi.fn();
vi.mock('@pagespace/lib/billing/org-gift', () => ({
  giftOrgSubscription: (...args: unknown[]) => giftOrgSubscription(...args),
  ungiftOrgSubscription: (...args: unknown[]) => ungiftOrgSubscription(...args),
}));

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: (...args: unknown[]) => auditRequest(...args) }));

const port = { retrieveCoupon: vi.fn(), createCoupon: vi.fn(), listOpenInvoiceIds: vi.fn(), voidInvoice: vi.fn(), updateSubscription: vi.fn(), setSeatQuantity: vi.fn() };
vi.mock('@/lib/stripe/org-gift-port', () => ({ orgGiftStripe: () => port }));

import { DELETE, POST } from '../route';

const ctx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const request = (method: 'POST' | 'DELETE', body: unknown) =>
  new NextRequest('https://admin.test/api/admin/orgs/org_1/gift-subscription', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  giftOrgSubscription.mockReset();
  ungiftOrgSubscription.mockReset();
  auditRequest.mockReset();
});

describe('POST /api/admin/orgs/[orgId]/gift-subscription', () => {
  it('SEAT-8 (partial) gifts the org named in the path for the pinned extra seats through the lib shell and the admin Stripe port, ignoring any subscription id in the body, and audits the reason', async () => {
    giftOrgSubscription.mockResolvedValue({ kind: 'gifted', subscriptionId: 'sub_org', couponId: 'GIFT_ORG_sub_org', status: 'active', restoresNow: false, giftedExtraSeats: 3, voidedInvoiceIds: [] });
    const res = await POST(request('POST', { reason: 'Design partner', extraSeats: 3, subscriptionId: 'sub_attacker' }), ctx('org_1'));
    expect(res.status).toBe(200);
    expect(giftOrgSubscription).toHaveBeenCalledWith({ orgId: 'org_1', adminUserId: 'admin-1', reason: 'Design partner', extraSeats: 3 }, port);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      userId: 'admin-1',
      resourceType: 'organization',
      resourceId: 'org_1',
      details: expect.objectContaining({ source: 'admin', action: 'gift_org_subscription', reason: 'Design partner', subscriptionId: 'sub_org', giftedExtraSeats: 3 }),
    }));
    expect(await res.json()).toMatchObject({ success: true, subscriptionId: 'sub_org' });
  });

  it.each([
    ['an empty reason', { reason: '  ', extraSeats: 0 }],
    ['no seat count', { reason: 'x' }],
    ['a negative seat count', { reason: 'x', extraSeats: -1 }],
    ['a fractional seat count', { reason: 'x', extraSeats: 1.5 }],
    ['a string seat count', { reason: 'x', extraSeats: '3' }],
  ])('refuses %s with 400', async (_label, body) => {
    const res = await POST(request('POST', body), ctx('org_1'));
    expect(res.status).toBe(400);
    expect(giftOrgSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['org_not_found', 404],
    ['billing_disabled', 404],
    ['admin_is_member', 400],
    ['invalid_seat_count', 400],
    ['no_subscription', 409],
    ['awaiting_first_payment', 409],
    ['already_gifted', 409],
  ])('maps a %s refusal to %i and audits nothing', async (reason, status) => {
    giftOrgSubscription.mockResolvedValue({ kind: 'refused', reason });
    const res = await POST(request('POST', { reason: 'x', extraSeats: 0 }), ctx('org_1'));
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(reason);
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('a Stripe failure is a 400 with a friendly message, never a gift', async () => {
    const { Stripe } = await import('@/lib/stripe');
    giftOrgSubscription.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ message: 'No such coupon', type: 'invalid_request_error' }));
    const res = await POST(request('POST', { reason: 'x', extraSeats: 0 }), ctx('org_1'));
    expect(res.status).toBe(400);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/orgs/[orgId]/gift-subscription', () => {
  it('SEAT-8 (partial) revokes the gift on the org named in the path and audits the reason', async () => {
    ungiftOrgSubscription.mockResolvedValue({ kind: 'ungifted', subscriptionId: 'sub_org', status: 'active', extraSeatQuantity: 0 });
    const res = await DELETE(request('DELETE', { reason: 'Partnership ended', subscriptionId: 'sub_attacker' }), ctx('org_1'));
    expect(res.status).toBe(200);
    expect(ungiftOrgSubscription).toHaveBeenCalledWith({ orgId: 'org_1', adminUserId: 'admin-1', reason: 'Partnership ended' }, port);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceType: 'organization',
      resourceId: 'org_1',
      details: expect.objectContaining({ source: 'admin', action: 'revoke_org_gift', reason: 'Partnership ended', subscriptionId: 'sub_org' }),
    }));
  });

  it('requires a non-empty reason', async () => {
    const res = await DELETE(request('DELETE', { reason: '' }), ctx('org_1'));
    expect(res.status).toBe(400);
    expect(ungiftOrgSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['not_gifted', 409],
    ['admin_is_member', 400],
    ['org_not_found', 404],
  ])('maps a %s refusal to %i and audits nothing', async (reason, status) => {
    ungiftOrgSubscription.mockResolvedValue({ kind: 'refused', reason });
    const res = await DELETE(request('DELETE', { reason: 'x' }), ctx('org_1'));
    expect(res.status).toBe(status);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});
