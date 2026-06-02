import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Section,
  Text,
} from '@react-email/components';
import { emailStyles, colors, spacing, typography } from './shared-styles';
import type { TierCreditSummary } from './credits-change-content';

interface CreditsChangeEmailProps {
  /** Recipient's display name (falls back to a friendly default upstream). */
  userName: string;
  /** Per-tier allowance + top-up copy, derived from credit-pricing. */
  summary: TierCreditSummary;
  /** Link to the in-app plan/billing screen where credits are managed. */
  manageUrl: string;
  /** Optional one-click unsubscribe link for the announcement. */
  unsubscribeUrl?: string;
}

const tierBox = {
  backgroundColor: colors.accent,
  borderLeft: `4px solid ${colors.accentBorder}`,
  padding: `${spacing.md} ${spacing.lg}`,
  margin: `${spacing.lg} 0`,
  borderRadius: '4px',
};

const allowanceAmount = {
  fontSize: typography.h2,
  fontWeight: typography.bold,
  color: colors.primary,
  margin: `0 0 ${spacing.xs} 0`,
  letterSpacing: '-0.4px',
};

const allowanceLabel = {
  fontSize: typography.small,
  color: colors.mutedText,
  margin: '0',
};

const packItem = {
  fontSize: typography.body,
  lineHeight: typography.bodyLineHeight,
  color: colors.text,
  margin: `0 0 ${spacing.xs} 0`,
};

export function CreditsChangeEmail({
  userName,
  summary,
  manageUrl,
  unsubscribeUrl,
}: CreditsChangeEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>
              Your AI usage is moving to monthly credits
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              We&apos;re changing how AI usage works in PageSpace. Instead of a
              daily cap on how many times you can call the AI, every plan now
              comes with a monthly pool of <strong>AI credits</strong> you can
              spend however you like — and you can top up anytime if you need
              more.
            </Text>

            <Section style={tierBox}>
              <Text style={allowanceLabel}>
                Your {summary.tierLabel} plan now includes
              </Text>
              <Text style={allowanceAmount}>
                {summary.monthlyAllowanceLabel} of AI credits / month
              </Text>
              <Text style={allowanceLabel}>
                Refreshes at the start of every billing period.
              </Text>
            </Section>

            <Text style={emailStyles.paragraph}>
              <strong>Need more?</strong> Top up your balance anytime with a
              one-time credit pack:
            </Text>
            {summary.topupPacks.map((pack) => (
              <Text key={pack.id} style={packItem}>
                • {pack.amountLabel} credits
              </Text>
            ))}

            <Text style={emailStyles.paragraph}>
              Credits only apply to AI features. Your documents, tasks,
              channels, files, and collaboration are completely unaffected —
              nothing about how you work with your team is changing.
            </Text>

            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={manageUrl}>
                View your plan &amp; credits
              </Button>
            </Section>

            <Text style={emailStyles.hint}>
              Questions? Just reply to this email and we&apos;ll help you out.
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this because you have a PageSpace account.
            </Text>
            {unsubscribeUrl ? (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from product update emails
                </Link>
              </Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
