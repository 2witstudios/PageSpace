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
      <Preview>Free credits are now a one-time starter grant. Everything you have stays yours.</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={darkHeader}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={eyebrow}>Plan update</Text>
            <Text style={emailStyles.contentHeading}>
              A change to credits on the Free plan
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              A quick, honest heads-up about how AI credits work on your Free
              plan. The short version: nothing you have is going away, but
              the monthly top-up is.
            </Text>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>What&apos;s changing</Text>
              <Text style={calloutText}>
                Until now, Free accounts received {starterCredits} credits
                every month, and unused credits piled up. Starting today,
                Free comes with {starterCredits} credits once, granted the
                first time you use AI. That grant doesn&apos;t refill.
              </Text>
            </Section>

            <Section style={keepCard}>
              <Text style={{ ...calloutText, fontWeight: typography.semibold, color: colors.heading }}>
                What you keep
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.xs }}>
                {currentCredits !== undefined ? (
                  <>
                    Every credit already in your account. You have{' '}
                    {currentCredits} credits right now, and they stay there
                    until you spend them. Credits never expire and nothing is
                    being taken back.
                  </>
                ) : (
                  <>
                    Your {starterCredits} starter credits are still waiting
                    for your first AI call, and once granted they never
                    expire.
                  </>
                )}
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.xs }}>
                Everything else on Free is unchanged: your documents, drives,
                tasks, channels, collaboration, storage, and the same set of
                AI models.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>When you run low</Text>
              <Text style={calloutText}>
                Two options, and both keep whatever balance you already
                have. Buy a top-up pack from {minTopup} (top-ups never
                expire), or upgrade to Pro for {proMonthlyCredits} credits
                every month that roll over when unused, plus the full model
                catalogue.
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

            <Text style={emailStyles.paragraph}>
              Why: free credits that refilled every month and never expired
              were an open-ended cost for a small team, and most Free
              accounts never used them. A one-time grant keeps Free
              genuinely free to try, and keeps us able to keep offering it.
            </Text>

            <Section style={emailStyles.buttonContainer}>
              <Button style={darkButton} href={planUrl}>
                See your plan
              </Button>
            </Section>

            <Text style={emailStyles.hint}>
              Questions, or think we got something wrong? Just reply to this
              email. We read every one.
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this because you have a PageSpace account
              on the Free plan. It&apos;s a notice about a change to your
              plan, so it goes to every Free account.
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
