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

interface SdkCliLaunchEmailProps {
  /** Recipient's display name (falls back to a friendly default upstream). */
  userName: string;
  /** Docs page for @pagespace/sdk — also the primary CTA target. */
  sdkDocsUrl: string;
  /** Docs page for @pagespace/cli. */
  cliDocsUrl: string;
  /** Docs page for the Agent API (OpenAI-compatible completions endpoint). */
  agentApiUrl: string;
  /** Blog post: building a chat app with PageSpace as the backend. */
  blogUrl: string;
  /** Optional one-click unsubscribe link for product-update emails. */
  unsubscribeUrl?: string;
  /**
   * The sender's physical postal address.
   *
   * CAN-SPAM wants one on COMMERCIAL email, which this is — every other template in this
   * directory is transactional and therefore exempt.
   *
   * The script does NOT refuse to send without it (this comment used to claim it did, but
   * `preflight` never checked): the owner deliberately shipped this launch with no address
   * rather than publish a home address, and accepted the tradeoff. See the pinning test,
   * "given no postal address, should STILL allow the live send".
   */
  postalAddress?: string;
}

// This launch email uses a black accent in place of the shared PageSpace blue,
// as a LOCAL override — shared-styles.ts (every other transactional email) stays
// on brand. INK is a near-black with a faint cool-neutral bias so it reads as a
// chosen color rather than a flat #000.
const INK = '#17181C';
const INK_LIFT = '#2C2E36';

// Eyebrow above the main heading: small, uppercase, accent color.
const eyebrow = {
  fontSize: typography.tiny,
  fontWeight: typography.semibold,
  color: INK,
  letterSpacing: '0.6px',
  textTransform: 'uppercase' as const,
  margin: `0 0 ${spacing.xs} 0`,
};

// Soft callout card, one per package.
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

// Install snippet. Monospace on a tinted panel; email clients ignore <pre>, so
// each command is its own Text line with the whitespace baked into the style.
const codeBlock = {
  backgroundColor: colors.heading,
  borderRadius: radius.md,
  padding: `${spacing.md} ${spacing.lg}`,
  margin: `${spacing.lg} 0`,
};

const codeLine = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: typography.small,
  lineHeight: '1.8',
  color: '#E8EAF0',
  margin: '0',
};

// Inline monospace for a command name mid-sentence (e.g. `pagespace mcp`).
const inlineCode = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '13px',
  color: colors.heading,
  backgroundColor: colors.accent,
  padding: '1px 5px',
  borderRadius: '4px',
};

const secondaryLink = {
  fontSize: typography.small,
  color: INK,
  textDecoration: 'underline',
};

// Local black-accent overrides of the shared (blue) header, button, and footer
// link — spread the shared style so only the color changes.
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

export function SdkCliLaunchEmail({
  userName,
  sdkDocsUrl,
  cliDocsUrl,
  agentApiUrl,
  blogUrl,
  unsubscribeUrl,
  postalAddress,
}: SdkCliLaunchEmailProps) {
  return (
    <Html>
      <Head />
      {/* The inbox snippet. Without it, clients scrape the first body text and
          show "New Browser for you… Hi Ada…". */}
      <Preview>Reach PageSpace from the browser, the terminal, or your own code</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={darkHeader}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={eyebrow}>Catch-up</Text>
            <Text style={emailStyles.contentHeading}>
              Browser for you. CLI for your agents. SDK for your apps.
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              We&apos;ve been heads-down shipping, and behind on telling you about
              it. So instead of trickling it out, here&apos;s a catch-up on what
              you can do in PageSpace now, starting with the part developers ask
              us about most.
            </Text>
            <Text style={emailStyles.paragraph}>
              You&apos;ve always worked in PageSpace through the browser. Now the
              same workspace (pages, drives, tasks, search, files) opens two
              more ways in: a command-line tool your agents can drive, and a
              TypeScript SDK your apps can build on. Both are live on npm.
            </Text>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>@pagespace/cli, for your agents</Text>
              <Text style={calloutText}>
                Your terminal, and the coding agents that live in it. A
                shell-capable agent like Claude Code drives PageSpace by running
                commands directly: read and write pages, run searches, manage
                tasks. It also ships an MCP server (
                <code style={inlineCode}>pagespace mcp</code>) that connects
                assistants without a terminal, like Claude Desktop and Cursor,
                to the same tools.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>@pagespace/sdk, for your apps</Text>
              <Text style={calloutText}>
                A typed TypeScript client for the PageSpace API: read and write
                pages, move things around a drive, create and update tasks, run a
                search, from a script or a backend. And every PageSpace agent
                answers on an OpenAI-compatible endpoint, so you can point a chat
                app straight at one and it brings your drive&apos;s content, its
                tools, and conversations that persist here in your workspace.
                Between them, PageSpace is not something your app connects to. It
                is the backend your app runs on.
              </Text>
              <Text style={{ ...calloutText, marginTop: spacing.sm }}>
                <Link href={blogUrl} style={secondaryLink}>
                  Build a support bot on it
                </Link>
                {'   ·   '}
                <Link href={agentApiUrl} style={secondaryLink}>
                  Agent API docs
                </Link>
              </Text>
            </Section>

            <Section style={codeBlock}>
              <Text style={codeLine}>npm install -g @pagespace/cli</Text>
              <Text style={codeLine}>pagespace login</Text>
              <Text style={codeLine}>npm install @pagespace/sdk</Text>
            </Section>

            <Text style={emailStyles.paragraph}>
              A good first use: point a terminal agent like Claude Code at a
              drive, and let it keep your notes, tasks, and docs current while
              you work. Nothing about your existing workspace changes. This is
              a new way in, not a new thing to learn.
            </Text>

            <Section style={emailStyles.buttonContainer}>
              <Button style={darkButton} href={cliDocsUrl}>
                Get started with the CLI
              </Button>
            </Section>

            <Text
              style={{
                ...emailStyles.hint,
                textAlign: 'center' as const,
                marginTop: spacing.sm,
              }}
            >
              <Link href={sdkDocsUrl} style={secondaryLink}>
                Or build with the SDK
              </Link>
            </Text>

            <Text style={emailStyles.hint}>
              Questions, or building something with it? Just reply to this email.
              We read every one.
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
            {/* CAN-SPAM requires a physical postal address on commercial email. */}
            {postalAddress ? (
              <Text style={emailStyles.footerText}>{postalAddress}</Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
