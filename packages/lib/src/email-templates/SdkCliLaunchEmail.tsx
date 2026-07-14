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
  /** Optional one-click unsubscribe link for product-update emails. */
  unsubscribeUrl?: string;
}

// Eyebrow above the main heading: small, uppercase, brand-tinted.
const eyebrow = {
  fontSize: typography.tiny,
  fontWeight: typography.semibold,
  color: colors.primary,
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

const secondaryLink = {
  fontSize: typography.small,
  color: colors.link,
  textDecoration: 'underline',
};

export function SdkCliLaunchEmail({
  userName,
  sdkDocsUrl,
  cliDocsUrl,
  unsubscribeUrl,
}: SdkCliLaunchEmailProps) {
  return (
    <Html>
      <Head />
      {/* The inbox snippet. Without it, clients scrape the first body text and
          show "New PageSpace now has an SDK and a CLI Hi Ada…". */}
      <Preview>Build on PageSpace from your own code and your terminal</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={eyebrow}>New</Text>
            <Text style={emailStyles.contentHeading}>
              PageSpace now has an SDK and a CLI
            </Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              Everything you do in PageSpace — pages, drives, tasks, search,
              files — is now something you can do from your own code and from
              your terminal. Two new packages are live on npm.
            </Text>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>@pagespace/sdk</Text>
              <Text style={calloutText}>
                A typed TypeScript client for the PageSpace API. Read and write
                pages, move things around a drive, create and update tasks, run
                a search — from a script, a backend service, or an agent you
                build yourself. Authentication is an API key you scope to the
                drives it&apos;s allowed to touch.
              </Text>
            </Section>

            <Section style={calloutCard}>
              <Text style={calloutHeading}>@pagespace/cli</Text>
              <Text style={calloutText}>
                The same capabilities from your terminal, so PageSpace can be a
                step in a shell script, a cron job, or a CI pipeline. It also
                runs as an MCP server, which lets coding agents like Claude Code
                read from and write to your PageSpace directly.
              </Text>
            </Section>

            <Section style={codeBlock}>
              <Text style={codeLine}>npm install @pagespace/sdk</Text>
              <Text style={codeLine}>npm install -g @pagespace/cli</Text>
              <Text style={codeLine}>pagespace login</Text>
            </Section>

            <Text style={emailStyles.paragraph}>
              A good first use: point an agent at a drive and let it keep your
              notes, tasks, and docs current while you work. Nothing about your
              existing workspace changes — this is a new way in, not a new thing
              to learn.
            </Text>

            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={sdkDocsUrl}>
                Get started with the SDK
              </Button>
            </Section>

            <Text
              style={{
                ...emailStyles.hint,
                textAlign: 'center' as const,
                marginTop: spacing.sm,
              }}
            >
              <Link href={cliDocsUrl} style={secondaryLink}>
                Or start with the CLI
              </Link>
            </Text>

            <Text style={emailStyles.hint}>
              Questions, or building something with it? Just reply to this email
              — we read every one.
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
