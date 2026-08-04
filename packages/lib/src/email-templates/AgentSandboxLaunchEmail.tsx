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
   * The sender's physical postal address. CAN-SPAM requires one on COMMERCIAL
   * email, which this is. The send script refuses a live run when
   * `COMPANY_POSTAL_ADDRESS` is empty (review #2326), so a live send always
   * renders the footer address; the prop stays optional for dry runs/previews.
   */
  postalAddress?: string;
}

// Same black accent as the SDK/CLI launch email (SdkCliLaunchEmail.tsx), as a
// LOCAL override — shared-styles.ts (every other transactional email) stays on
// the brand blue. INK is a near-black with a faint cool-neutral bias so it
// reads as a chosen color rather than a flat #000.
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

// Local black-accent overrides of the shared (blue) header, button, and footer
// link — spread the shared style so only the color changes (mirrors the SDK
// launch email).
const darkHeader = {
  ...emailStyles.header,
  background: `linear-gradient(135deg, ${INK} 0%, ${INK_LIFT} 100%)`,
};

const darkButton = {
  ...emailStyles.button,
  background: `linear-gradient(135deg, ${INK} 0%, ${INK_LIFT} 100%)`,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28), 0 1px 2px rgba(0, 0, 0, 0.18)',
};

const darkFooterLink = { ...emailStyles.link, color: INK };

// Pro-tier note: a distinct tinted card so the pricing boundary reads as a
// clear fact, not a buried caveat at the bottom of the email.
const proNoteCard = {
  backgroundColor: colors.accent,
  borderLeft: `4px solid ${INK}`,
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
          <Section style={darkHeader}>
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
                drive owned by a Pro account, every member with edit access
                gets the sandbox in that drive&apos;s sessions, even members
                on Free themselves. Your personal Global Assistant sessions
                run on your own plan. Upgrade to Pro and the sandbox turns on
                everywhere it already shows up in your workspace, billed from
                the same credit balance as everything else you do in
                PageSpace — no separate charge.
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
              <Button style={darkButton} href={agentsUrl}>
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
                <Link href={unsubscribeUrl} style={darkFooterLink}>
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
