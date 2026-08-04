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

interface AgentSandboxLaunchEmailProps {
  /** Recipient's display name (falls back to a friendly default upstream). */
  userName: string;
  /** The Agents screen — primary CTA target. */
  agentsUrl: string;
  /** The "Your Agents Just Got a Computer" launch post. */
  blogUrl: string;
  /** Pricing page — where the Pro-tier boundary is explained. */
  pricingUrl: string;
  /** Optional one-click unsubscribe link for product-update emails. */
  unsubscribeUrl?: string;
  /**
   * The sender's physical postal address. CAN-SPAM wants one on COMMERCIAL
   * email, which this is. Not enforced by `preflight` — see the identical
   * note on `SdkCliLaunchEmailProps.postalAddress`.
   */
  postalAddress?: string;
}

const eyebrow = {
  fontSize: typography.tiny,
  fontWeight: typography.semibold,
  color: colors.primary,
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
  color: colors.link,
  textDecoration: 'underline',
};

// Pro-tier note: a distinct tinted card so the pricing boundary reads as a
// clear fact, not a buried caveat at the bottom of the email.
const proNoteCard = {
  backgroundColor: colors.accent,
  borderLeft: `4px solid ${colors.accentBorder}`,
  borderRadius: radius.sm,
  padding: `${spacing.md} ${spacing.lg}`,
  margin: `${spacing.lg} 0`,
};

export function AgentSandboxLaunchEmail({
  userName,
  agentsUrl,
  blogUrl,
  pricingUrl,
  unsubscribeUrl,
  postalAddress,
}: AgentSandboxLaunchEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Real cloud sandboxes, multi-agent panes, and automations that run code on their own</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={eyebrow}>Product update</Text>
            <Text style={emailStyles.contentHeading}>
              Your agents can code now — in a real machine, in the cloud
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              Back in June we told you agents would run real code in
              sandboxed containers inside your workspace. Today that&apos;s
              live, along with two things that make it actually useful.
            </Text>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>Your agent runs on a real machine</Text>
              <Text style={calloutText}>
                Start a session and PageSpace provisions a real cloud
                computer behind it — a real filesystem, a real shell, a real
                terminal. When your agent runs a build or touches git,
                it&apos;s not simulating anything. It&apos;s doing the work.
                And you&apos;re never locked out of it: open a terminal on
                the same machine and you&apos;re looking at exactly what
                your agent sees.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>The Agents screen splits into panes</Text>
              <Text style={calloutText}>
                Run more than one agent at once — a researcher next to a
                coder next to the document they&apos;re both writing into.
                Put an agent next to the terminal it&apos;s driving, or the
                task list it&apos;s working through, and watch it happen
                instead of taking it on faith.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>Automations can write and run code on their own</Text>
              <Text style={calloutText}>
                The Workflows you already trigger on a schedule, a webhook,
                or a task due date aren&apos;t limited to reading and
                summarizing anymore. A workflow can pull data, run a script,
                commit the result — while you&apos;re not watching.
              </Text>
            </Section>

            <Section style={proNoteCard}>
              <Text style={{ ...calloutText, fontWeight: typography.semibold, color: colors.heading }}>
                The sandbox is a Pro-plan feature.
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.xs }}>
                Free gets the full interface — sessions, chat, panes,
                Workflows — everything except the machine underneath it.
                Sandbox access follows whoever pays for the workspace: in a
                drive owned by a Pro account, every member gets the sandbox,
                even members on Free themselves. Upgrade to Pro and the
                sandbox turns on everywhere it already shows up in your
                workspace, billed from the same credit balance as everything
                else you do in PageSpace — no separate charge.
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.sm }}>
                <Link href={pricingUrl} style={secondaryLink}>
                  See what&apos;s on Pro
                </Link>
                {'   ·   '}
                <Link href={blogUrl} style={secondaryLink}>
                  Read the full announcement
                </Link>
              </Text>
            </Section>

            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={agentsUrl}>
                Open the Agents screen
              </Button>
            </Section>

            <Text style={emailStyles.hint}>
              If you&apos;re already on Pro, Founder, or Business: nothing
              to do. Go start a session.
            </Text>
            <Text style={emailStyles.hint}>
              Questions? Just reply to this email. We read every one.
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
            {postalAddress ? (
              <Text style={emailStyles.footerText}>{postalAddress}</Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
