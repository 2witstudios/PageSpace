import { describe, it, expect, beforeEach, vi } from 'vitest';

const { retrievePaymentIntent } = vi.hoisted(() => ({ retrievePaymentIntent: vi.fn() }));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  resolveAppUrl: vi.fn().mockReturnValue('https://app.example.com'),
}));
vi.mock('@pagespace/lib/email-templates/PaymentReceiptEmail', () => ({
  PaymentReceiptEmail: () => null,
}));
vi.mock('@/lib/stripe', () => ({
  stripe: { paymentIntents: { retrieve: retrievePaymentIntent } },
}));

import { sendSubscriptionReceiptEmail, sendTopupReceiptEmail } from '../send-payment-receipt-email';
import { sendEmail } from '@pagespace/lib/services/email-service';

function buildInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_123',
    currency: 'usd',
    amount_paid: 2000,
    created: 1752800000,
    status_transitions: { paid_at: 1752800100 },
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_1',
    total_taxes: null,
    lines: { data: [{ description: 'PageSpace Pro (monthly)', amount: 2000 }] },
    ...overrides,
  };
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_123',
    currency: 'usd',
    amount_total: 2500,
    created: 1752800000,
    payment_intent: 'pi_123',
    total_details: null,
    ...overrides,
  };
}

describe('sendSubscriptionReceiptEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a paid invoice, should send to the given email with the invoice total', async () => {
    await sendSubscriptionReceiptEmail({
      invoice: buildInvoice() as never,
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_1',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendEmail).mock.calls[0][0];
    expect(args.to).toBe('ann@example.com');
    expect(args.idempotencyKey).toBe('receipt:evt_1');
  });

  it('given no total_taxes, should omit taxFormatted from the template props', async () => {
    await sendSubscriptionReceiptEmail({
      invoice: buildInvoice({ total_taxes: null }) as never,
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_1',
    });

    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.taxFormatted).toBeUndefined();
  });

  it('given total_taxes present, should sum them into taxFormatted', async () => {
    await sendSubscriptionReceiptEmail({
      invoice: buildInvoice({ total_taxes: [{ amount: 100 }, { amount: 50 }] }) as never,
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_1',
    });

    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.taxFormatted).toBe('$1.50');
  });

  it('given the invoice has no line items, should fall back to a generic description and the amount_paid total', async () => {
    await sendSubscriptionReceiptEmail({
      invoice: buildInvoice({ lines: { data: [] } }) as never,
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_1',
    });

    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.description).toBe('PageSpace subscription');
    expect(props.lineItems).toEqual([{ description: 'PageSpace subscription', amountFormatted: '$20.00' }]);
  });

  it('should never fetch a payment intent (no last4 for subscription receipts)', async () => {
    await sendSubscriptionReceiptEmail({
      invoice: buildInvoice() as never,
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_1',
    });

    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('given sendEmail throws, should swallow the error rather than rethrow', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('rate limited'));

    await expect(
      sendSubscriptionReceiptEmail({
        invoice: buildInvoice() as never,
        email: 'ann@example.com',
        userName: 'Ann',
        eventId: 'evt_1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('sendTopupReceiptEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrievePaymentIntent.mockResolvedValue({ latest_charge: null });
  });

  it('given a completed credit-pack session, should send using the pack label and session total', async () => {
    await sendTopupReceiptEmail({
      session: buildSession() as never,
      packLabel: '$25 credits',
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_2',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.description).toBe('$25 credits');
    expect(props.totalFormatted).toBe('$25.00');
  });

  it('given a resolvable payment_intent, should fetch last4/receipt_url from the latest charge', async () => {
    retrievePaymentIntent.mockResolvedValueOnce({
      latest_charge: {
        payment_method_details: { card: { last4: '4242' } },
        receipt_url: 'https://pay.stripe.com/receipts/abc',
      },
    });

    await sendTopupReceiptEmail({
      session: buildSession() as never,
      packLabel: '$25 credits',
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_2',
    });

    expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_123', { expand: ['latest_charge'] });
    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.last4).toBe('4242');
    expect(props.invoiceUrl).toBe('https://pay.stripe.com/receipts/abc');
  });

  it('given the payment_intent fetch fails, should omit last4/invoiceUrl rather than throw', async () => {
    retrievePaymentIntent.mockRejectedValueOnce(new Error('network blip'));

    await expect(
      sendTopupReceiptEmail({
        session: buildSession() as never,
        packLabel: '$25 credits',
        email: 'ann@example.com',
        userName: 'Ann',
        eventId: 'evt_2',
      }),
    ).resolves.toBeUndefined();
    const props = (vi.mocked(sendEmail).mock.calls[0][0].react as { props: Record<string, unknown> }).props;
    expect(props.last4).toBeUndefined();
    expect(props.invoiceUrl).toBeUndefined();
  });

  it('given no payment_intent on the session, should not attempt the fetch', async () => {
    await sendTopupReceiptEmail({
      session: buildSession({ payment_intent: null }) as never,
      packLabel: '$25 credits',
      email: 'ann@example.com',
      userName: 'Ann',
      eventId: 'evt_2',
    });

    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('given sendEmail throws, should swallow the error rather than rethrow', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('rate limited'));

    await expect(
      sendTopupReceiptEmail({
        session: buildSession() as never,
        packLabel: '$25 credits',
        email: 'ann@example.com',
        userName: 'Ann',
        eventId: 'evt_2',
      }),
    ).resolves.toBeUndefined();
  });
});
