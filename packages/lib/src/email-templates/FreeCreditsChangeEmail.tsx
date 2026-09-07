import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { emailStyles, colors, spacing, typography, radius } from './shared-styles';

interface FreeCreditsChangeEmailProps {
  /** Recipient's display name (falls back to a friendly default upstream). */
  userName: string;
  /**
   * The recipient's current spendable credit balance as a display string (e.g. "3.2"),
   * or undefined when they have never used AI and therefore have no balance row yet —
   * in which case the email tells them their starter credits are still waiting.
   */
  currentCredits?: string;
  /**
   * How far in the red the recipient is, as a positive display string (e.g. "0.3"),
   * when their balance is negative (an in-flight call overshot). Mutually exclusive
   * with `currentCredits`; when set the email says a top-up clears the overage.
   */
  overageCredits?: string;
  /** The free starter grant, as a display string (e.g. "5"). */
  starterCredits: string;
  /** The Pro plan's monthly allowance, as a display string (e.g. "15"). */
  proMonthlyCredits: string;
  /** Cheapest top-up, as a dollar string (e.g. "$5"). */
  minTopup: string;
  /** In-app plan page — primary CTA. */
  planUrl: string;
  /** In-app usage/credits page — where top-ups are bought. */
  usageUrl: string;
  /**
   * The sender's physical postal address. This is a RELATIONSHIP message (a notice of a
   * change to the recipient's existing plan), which CAN-SPAM exempts from the commercial
   * requirements — so there is deliberately no unsubscribe link, and the address is
   * optional. Rendered in the footer when provided.
   */
  postalAddress?: string;
}

// Same black accent as the launch emails, as a LOCAL override — shared-styles.ts
// (every other transactional email) stays on the brand blue.
const INK = '#17181C';
const INK_LIFT = '#2C2E36';

const eyebrow = {
  fontSize: typography.tiny,
  fontWeight: typography.semibold,
  color: INK,
  letterSpacing: '0.6px',
  textTransform: 'uppercase' as const,
  margin: `0 0 ${spacing.xs} 0`,
};

const calloutCard = {
  backgroundColor: colors.pageBackground,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.md,
  padding: `${spacing.md} ${spacing.lg}`,
  margin: `${spacing.md} 0`,
};

const calloutHeading = {
  fontSize: typography.h3,
  fontWeight: typography.semibold,
  color: colors.heading,
  margin: `0 0 ${spacing.xs} 0`,
  letterSpacing: '-0.2px',
};

const calloutText = {
  fontSize: typography.small,
  lineHeight: typography.bodyLineHeight,
  color: colors.text,
  margin: '0',
};

const secondaryLink = {
  fontSize: typography.small,
  color: INK,
  textDecoration: 'underline',
};

const darkHeader = {
  ...emailStyles.header,
  background: `linear-gradient(135deg, ${INK} 0%, ${INK_LIFT} 100%)`,
};

const darkButton = {
  ...emailStyles.button,
  background: `linear-gradient(135deg, ${INK} 0%, ${INK_LIFT} 100%)`,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28), 0 1px 2px rgba(0, 0, 0, 0.18)',
};

// The "what you keep" card is the one fact people will look for, so it gets
// the tinted, left-ruled treatment rather than the plain callout.
const keepCard = {
  backgroundColor: colors.accent,
  borderLeft: `4px solid ${INK}`,
  borderRadius: radius.sm,
  padding: `${spacing.md} ${spacing.lg}`,
  margin: `${spacing.lg} 0`,
};

/**
 * Notice to every Free-plan account that free credits are now a one-time
 * starter grant rather than a monthly, accumulating allowance. Sent once by
 * scripts/send-free-credits-change-notifications.ts.
 */
export function FreeCreditsChangeEmail({
  userName,
  currentCredits,
  overageCredits,
  starterCredits,
  proMonthlyCredits,
  minTopup,
  planUrl,
  usageUrl,
  postalAddress,
}: FreeCreditsChangeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Free plan credits are now a one-time grant of {starterCredits}. Your current balance is unchanged.</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={darkHeader}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={eyebrow}>Plan update</Text>
            <Text style={emailStyles.contentHeading}>
              Free plan credits are changing
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              Starting today, the Free plan includes a one-time grant of{' '}
              {starterCredits} credits instead of {starterCredits} credits per
              month. The grant is added the first time you use AI and is not
              renewed.
            </Text>
            <Text style={emailStyles.paragraph}>
              This lets us keep the Free plan available and put more into the
              product for the people using it.
            </Text>

            <Section style={keepCard}>
              <Text style={{ ...calloutText, fontWeight: typography.semibold, color: colors.heading }}>
                Your current balance is not affected
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.xs }}>
                {overageCredits !== undefined ? (
                  <>
                    Your balance is {overageCredits} credits in the red. A
                    top-up clears the overage first and the rest is added to
                    your balance; purchased credits do not expire.
                  </>
                ) : currentCredits !== undefined ? (
                  <>
                    You have {currentCredits} credits. They remain available
                    until you use them and do not expire.
                  </>
                ) : (
                  <>
                    You have not used AI yet. Your {starterCredits} starter
                    credits will be added on your first AI request and do not
                    expire.
                  </>
                )}
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.xs }}>
                Storage, documents, drives, tasks, channels, and the Free plan
                model list are unchanged.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>Adding credits</Text>
              <Text style={calloutText}>
                Top-up packs start at {minTopup} and do not expire. The Pro plan
                includes {proMonthlyCredits} credits per month, unused credits
                carry over, and all models are available.
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.sm }}>
                <Link href={usageUrl} style={secondaryLink}>
                  Buy credits
                </Link>
                {'   ·   '}
                <Link href={planUrl} style={secondaryLink}>
                  Compare plans
                </Link>
              </Text>
            </Section>

            <Section style={emailStyles.buttonContainer}>
              <Button style={darkButton} href={planUrl}>
                View your plan
              </Button>
            </Section>

            <Text style={emailStyles.hint}>
              Reply to this email if you have questions.
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You are receiving this notice because your PageSpace account is
              on the Free plan.
            </Text>
            {postalAddress ? (
              <Text style={emailStyles.footerText}>{postalAddress}</Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
