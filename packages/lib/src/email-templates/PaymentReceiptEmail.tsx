import * as React from 'react';
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Row,
  Section,
  Text,
} from '@react-email/components';
import { emailStyles } from './shared-styles';

interface PaymentReceiptLineItem {
  description: string;
  amountFormatted: string;
}

interface PaymentReceiptEmailProps {
  userName: string;
  description: string;
  dateFormatted: string;
  lineItems: PaymentReceiptLineItem[];
  taxFormatted?: string;
  totalFormatted: string;
  last4?: string;
  invoiceUrl?: string;
  billingSettingsUrl: string;
}

const lineItemCell: React.CSSProperties = {
  fontSize: emailStyles.paragraph.fontSize,
  color: emailStyles.paragraph.color,
  padding: '4px 0',
};

const lineItemAmountCell: React.CSSProperties = {
  ...lineItemCell,
  textAlign: 'right',
};

const totalCell: React.CSSProperties = {
  ...lineItemCell,
  fontWeight: emailStyles.contentHeading.fontWeight,
  color: emailStyles.contentHeading.color,
};

const totalAmountCell: React.CSSProperties = {
  ...totalCell,
  textAlign: 'right',
};

export function PaymentReceiptEmail({
  userName,
  description,
  dateFormatted,
  lineItems,
  taxFormatted,
  totalFormatted,
  last4,
  invoiceUrl,
  billingSettingsUrl,
}: PaymentReceiptEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Payment received</Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              Thanks for your payment. Here&apos;s your receipt for {description} on {dateFormatted}.
            </Text>

            {lineItems.map((item, index) => (
              <Row key={index}>
                <Column style={lineItemCell}>{item.description}</Column>
                <Column style={lineItemAmountCell}>{item.amountFormatted}</Column>
              </Row>
            ))}

            {taxFormatted && (
              <Row>
                <Column style={lineItemCell}>Tax</Column>
                <Column style={lineItemAmountCell}>{taxFormatted}</Column>
              </Row>
            )}

            <Section style={emailStyles.divider} />

            <Row>
              <Column style={totalCell}>Total</Column>
              <Column style={totalAmountCell}>{totalFormatted}</Column>
            </Row>

            {last4 && (
              <Text style={emailStyles.hint}>Charged to card ending in {last4}.</Text>
            )}

            {invoiceUrl && (
              <Text style={emailStyles.hint}>
                <Link href={invoiceUrl} style={emailStyles.link}>
                  View full invoice
                </Link>
              </Text>
            )}

            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={billingSettingsUrl}>
                View Billing History
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              This is a receipt for your PageSpace payment.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
