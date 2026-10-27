import React from 'react';
import { PaymentReceiptEmail } from '../src/email-templates/PaymentReceiptEmail';

export default function PaymentReceiptEmailPreview() {
  return (
    <PaymentReceiptEmail
      userName="Sarah Chen"
      description="PageSpace Pro — monthly renewal"
      dateFormatted="Jul 18, 2026"
      lineItems={[{ description: 'PageSpace Pro (monthly)', amountFormatted: '$20.00' }]}
      totalFormatted="$20.00"
      last4="4242"
      invoiceUrl="https://invoice.stripe.com/i/acct_123/test_456"
      billingSettingsUrl="https://app.pagespace.com/settings/billing"
    />
  );
}
