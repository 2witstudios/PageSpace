import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createPaidInvoiceReader, parseProofOptions, planFundingProof, restoreFundingProof, type PaidInvoice } from '../restore-org-funding-proof';

const org = { orgId: 'org_1', customerId: 'cus_1', subscriptionId: 'sub_1', giftedExtraSeats: null };
const prices = { basePriceId: 'price_base', seatPriceId: 'price_seat' };
function invoice(overrides: Partial<PaidInvoice> = {}): PaidInvoice {
  return {
    id: 'in_1', status: 'paid', customer: 'cus_1', amount_paid: 5000,
    parent: { subscription_details: { subscription: 'sub_1', metadata: {} } },
    lines: { has_more: false, data: [{ amount: 5000,
      pricing: { price_details: { price: 'price_base' } },
      parent: { subscription_item_details: { subscription_item: 'si_1' } },
    }] }, ...overrides,
  };
}
describe('historical organization funding proof', () => {
  it('SEAT-9 (partial) accepts verified payment independently of any wallet balance', () => {
    expect(planFundingProof(org, invoice(), prices)).toEqual({ ...org, invoiceId: 'in_1', basis: 'paid', paidCents: 5000 });
  });
  it.each([
    { status: 'open' }, { customer: 'cus_other' },
    { parent: { subscription_details: { subscription: 'sub_old' } } },
    { amount_paid: 0 }, { lines: { has_more: true, data: [] } },
    { lines: { has_more: false, data: [{ amount: 5000, pricing: { price_details: { price: 'price_unknown' } }, parent: { subscription_item_details: { subscription_item: 'si_1' } } }] } },
  ] satisfies Partial<PaidInvoice>[])('SEAT-9 (partial) rejects unpaid, mismatched or incomplete evidence: %j', (overrides) => {
    expect(() => planFundingProof(org, invoice(overrides), prices)).toThrow();
  });
  it('SEAT-9 (partial) accepts a supported gift on the current subscription, with its admin-pinned seats (D-OW-54)', () => {
    const gift = invoice({ amount_paid: 0, parent: { subscription_details: {
      subscription: 'sub_1', metadata: { type: 'gift_subscription' },
    } } });
    expect(planFundingProof({ ...org, giftedExtraSeats: 0 }, gift, prices)).toMatchObject({ basis: 'gift', paidCents: 0 });
    // A gift without a stored pin is not an admin gift: it is no funding evidence (fail closed).
    expect(() => planFundingProof(org, gift, prices)).toThrow('Invoice has no verified organization funding');
  });
  it('dry-run writes nothing; apply hands verified evidence to the conditional store', async () => {
    const apply = vi.fn().mockResolvedValue(true);
    const deps = { loadOrg: async () => org, readInvoice: async () => invoice(), apply, prices };
    expect(await restoreFundingProof(deps, { orgId: 'org_1', invoiceId: 'in_1', apply: false })).toMatchObject({ applied: false });
    expect(apply).not.toHaveBeenCalled();
    expect(await restoreFundingProof(deps, { orgId: 'org_1', invoiceId: 'in_1', apply: true })).toMatchObject({ applied: true });
    expect(apply).toHaveBeenCalledWith(planFundingProof(org, invoice(), prices));
  });
  it('an invoice retrieval failure or mismatched response cannot write proof', async () => {
    const apply = vi.fn();
    const deps = { loadOrg: async () => org, readInvoice: async () => invoice({ id: 'in_wrong' }), apply, prices };
    await expect(restoreFundingProof(deps, { orgId: 'org_1', invoiceId: 'in_1', apply: true })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
  it('fetches every invoice line and rejects interrupted pagination', async () => {
    const first = invoice().lines!.data![0];
    const unknown = { ...first, pricing: { price_details: { price: 'price_other' } } };
    const stripe = { invoices: {
      retrieve: async () => invoice({ lines: { has_more: true, data: [first] } }),
      listLineItems: async function* () { yield first; yield unknown; },
    } } as unknown as Stripe;
    const complete = await createPaidInvoiceReader(stripe)('in_1');
    expect(complete.lines?.data).toHaveLength(2);
    expect(() => planFundingProof(org, complete, prices)).toThrow('no verified');
    const failing = { invoices: {
      retrieve: async () => invoice(),
      listLineItems: async function* () { yield first; throw new Error('page unavailable'); },
    } } as unknown as Stripe;
    await expect(createPaidInvoiceReader(failing)('in_1')).rejects.toThrow('page unavailable');
  });
  it('requires explicit identifiers, defaults to dry-run and refuses conflicting modes', () => {
    expect(parseProofOptions(['--org', 'org_1', '--invoice', 'in_1'])).toEqual({ orgId: 'org_1', invoiceId: 'in_1', apply: false });
    expect(() => parseProofOptions(['--org', 'org_1'])).toThrow();
    expect(() => parseProofOptions(['--org', 'org_1', '--invoice', 'in_1', '--apply', '--dry-run'])).toThrow();
    expect(() => parseProofOptions(['--org', 'org_1', '--invoice', 'in_1', '--unknown'])).toThrow();
  });
});
