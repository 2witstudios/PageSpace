import { describe, it, expect } from 'vitest';
import { PaymentReceiptEmail, type PaymentReceiptEmailProps } from '../PaymentReceiptEmail';
import { renderEmailToHtml } from '../render-email';

const PROPS: PaymentReceiptEmailProps = {
  userName: 'Ada',
  description: 'PageSpace Pro — monthly renewal',
  dateFormatted: 'Jul 18, 2026',
  lineItems: [{ description: 'PageSpace Pro (monthly)', amountFormatted: '$20.00' }],
  totalFormatted: '$20.00',
  billingSettingsUrl: 'https://app.pagespace.ai/settings/billing',
};

const render = (props: Partial<PaymentReceiptEmailProps> = {}) =>
  renderEmailToHtml(PaymentReceiptEmail({ ...PROPS, ...props }));

describe('PaymentReceiptEmail', () => {
  it('given a receipt with line items, should list each description and amount', async () => {
    const html = await render();

    expect(html).toContain('PageSpace Pro (monthly)');
    expect(html).toContain('$20.00');
  });

  it('given a total, should print it', async () => {
    const html = await render({ totalFormatted: '$45.00' });

    expect(html).toContain('$45.00');
  });

  it('given no taxFormatted/last4/invoiceUrl, should omit those optional lines entirely', async () => {
    const html = await render();

    expect(html).not.toContain('Tax');
    expect(html).not.toContain('ending in');
    expect(html).not.toContain('View full invoice');
  });

  it('given all optional fields present, should show the tax line, last4 line, and invoice link', async () => {
    const html = await render({
      taxFormatted: '$2.00',
      last4: '4242',
      invoiceUrl: 'https://invoice.stripe.com/i/acct_123/test_456',
    });

    expect(html).toContain('$2.00');
    expect(html).toContain('4242');
    expect(html).toContain('ending in');
    expect(html).toContain('View full invoice');
    expect(html).toContain('https://invoice.stripe.com/i/acct_123/test_456');
  });

  it('given the footer, should contain no unsubscribe link (transactional receipt)', async () => {
    const html = await render();

    expect(html).not.toContain('Unsubscribe');
    expect(html).not.toContain('unsubscribe');
  });

  it('given a recipient name, should greet them by it', async () => {
    const html = await render({ userName: 'Grace' });

    expect(html).toContain('Grace');
    expect(html).toMatch(/Hi\s*(<!--\s*-->)?\s*Grace/);
  });

  it('given a billing settings URL, should link the CTA button to it', async () => {
    const html = await render();

    expect(html).toContain('https://app.pagespace.ai/settings/billing');
    expect(html).toContain('Billing History');
  });
});
