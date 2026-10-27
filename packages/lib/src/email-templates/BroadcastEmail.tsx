import * as React from 'react';
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { emailStyles } from './shared-styles';

interface BroadcastEmailProps {
  /** Inbox snippet. Without it, clients scrape the first body text of the article. */
  preview: string;
  /**
   * The admin's markdown, already rendered to SANITIZED HTML by
   * `services/broadcast/content.ts`. Injected with `dangerouslySetInnerHTML`, so this
   * prop is the trust boundary: it must never carry raw admin input.
   */
  bodyHtml: string;
  /**
   * Per-recipient one-click unsubscribe link. NOT optional: this template only ever
   * renders bulk mail, and bulk mail without a working opt-out is what gets a sending
   * domain throttled — and is the harm an unsubscribe exists to prevent. A dry-run
   * preview passes a placeholder rather than dropping the footer, so what the admin
   * approves is the shape of what the recipient gets.
   */
  unsubscribeUrl: string;
  /**
   * The sender's physical postal address, from COMPANY_POSTAL_ADDRESS.
   *
   * CAN-SPAM wants one on COMMERCIAL email, which a broadcast is — every other template
   * in this directory is transactional and therefore exempt.
   *
   * Optional, and NOT enforced anywhere: the owner deliberately shipped the SDK/CLI
   * launch without an address rather than publish a home address, and accepted the
   * tradeoff. `core.preflight` therefore does not check it (pinned by a test in
   * `services/broadcast/__tests__/core.test.ts`). Set COMPANY_POSTAL_ADDRESS to include
   * one; making it a hard block is a product decision, not a code cleanup.
   */
  postalAddress?: string;
}

/**
 * The branded shell every admin-composed broadcast renders into.
 *
 * Mirrors `SdkCliLaunchEmail.tsx`'s structure — header, content, footer built from
 * `shared-styles.ts` — but the middle is author-supplied rather than hand-written, so
 * the admin controls the words and never the chrome, the unsubscribe footer, or the
 * markup that carries them.
 */
export function BroadcastEmail({
  preview,
  bodyHtml,
  unsubscribeUrl,
  postalAddress,
}: BroadcastEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            {/* Sanitized upstream against a tight allowlist (see content.ts). React
                Email has no markdown primitive, and a string of HTML is what the
                markdown pipeline produces, so it is injected rather than re-parsed. */}
            <div
              style={{ ...emailStyles.paragraph, margin: '0' }}
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this because you have a PageSpace account.
            </Text>
            <Text style={emailStyles.footerText}>
              <Link href={unsubscribeUrl} style={emailStyles.link}>
                Unsubscribe from these emails
              </Link>
            </Text>
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