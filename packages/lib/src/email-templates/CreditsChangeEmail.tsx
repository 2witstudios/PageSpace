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
import { emailStyles, colors, spacing, typography, radius } from './shared-styles';
import type { TierCreditSummary } from './credits-change-content';

interface CreditsChangeEmailProps {
  /** Recipient's display name (falls back to a friendly default upstream). */
  userName: string;
  /** Per-tier allowance + top-up copy, derived from credit-pricing. */
  summary: TierCreditSummary;
  /** Link to the in-app plan/billing screen where credits are managed. */
  manageUrl: string;
  /** Optional link to the full launch announcement blog post. */
  blogUrl?: string;
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

// Eyebrow above the main heading: small, uppercase, brand-tinted.
const eyebrow = {
  fontSize: typography.tiny,
  fontWeight: typography.semibold,
  color: colors.primary,
  letterSpacing: '0.6px',
  textTransform: 'uppercase' as const,
  margin: `0 0 ${spacing.xs} 0`,
};

// Soft callout card (model choice, top-ups), lighter than the tier box.
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

const packItem = {
  fontSize: typography.body,
  lineHeight: typography.bodyLineHeight,
  color: colors.text,
  margin: `0 0 ${spacing.xs} 0`,
};

const secondaryLink = {
  fontSize: typography.small,
  color: colors.link,
  textDecoration: 'underline',
};

export function CreditsChangeEmail({
  userName,
  summary,
  manageUrl,
  blogUrl,
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
            <Text style={eyebrow}>What&apos;s new</Text>
            <Text style={emailStyles.contentHeading}>
              AI is now usage-based credits
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              We&apos;ve replaced the old daily cap on AI calls with something
              simpler and fairer. Every plan now comes with a monthly pool of{' '}
              <strong>credits</strong> you spend however you like, billed based
              on what each model actually costs, so what you pay tracks what you
              actually do.
            </Text>

            <Section style={tierBox}>
              <Text style={allowanceLabel}>
                Your {summary.tierLabel} plan now includes
              </Text>
              <Text style={allowanceAmount}>
                {summary.monthlyAllowanceLabel} credits / month
              </Text>
              <Text style={allowanceLabel}>
                Refreshes at the start of every billing period.
              </Text>
            </Section>

            {/* Model choice: the upside of usage-based billing, per tier. */}
            <Section style={calloutCard}>
              <Text style={calloutHeading}>
                {summary.unlocksPremiumModels
                  ? 'Run the models you want'
                  : 'Fast models, tuned to go far'}
              </Text>
              <Text style={calloutText}>
                {summary.unlocksPremiumModels
                  ? 'Your plan unlocks the frontier. Spend credits on Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro, and more. Reach for a light model on quick work and a flagship when it counts. You choose the trade-off per task.'
                  : 'Your plan runs on fast, capable standard models tuned to make your credits stretch. No setup, no model wrangling, just send a message and go.'}
              </Text>
            </Section>

            {/* Top-ups: custom amount plus quick-pick packs. */}
            <Section style={calloutCard}>
              <Text style={calloutHeading}>Run low? Top up in seconds</Text>
              <Text style={calloutText}>
                Add any amount from{' '}
                <strong>
                  {summary.topupMinLabel} to {summary.topupMaxLabel}
                </strong>
                , or grab a quick pack. Top-up credits never expire.
              </Text>
            </Section>
            {summary.topupPacks.map((pack) => (
              <Text key={pack.id} style={packItem}>
                • {pack.amountLabel} credits
              </Text>
            ))}

            <Text style={emailStyles.paragraph}>
              Credits only apply to AI features. Your documents, tasks,
              channels, files, and collaboration are completely unaffected.
              Nothing about how you work with your team is changing.
            </Text>

            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={manageUrl}>
                View your plan &amp; credits
              </Button>
            </Section>

            {blogUrl ? (
              <Text style={{ ...emailStyles.hint, textAlign: 'center' as const, marginTop: spacing.sm }}>
                <Link href={blogUrl} style={secondaryLink}>
                  Read the full announcement
                </Link>
              </Text>
            ) : null}

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
