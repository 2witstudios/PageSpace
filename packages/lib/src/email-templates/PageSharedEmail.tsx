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
import { emailStyles } from './shared-styles';

interface PageSharedEmailProps {
  userName: string;
  sharerName: string;
  pageTitle: string;
  permissions: string[];
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function PageSharedEmail({
  userName,
  sharerName,
  pageTitle,
  permissions,
  viewUrl,
  unsubscribeUrl,
}: PageSharedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>{sharerName} shared a page with you</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{sharerName}</strong> shared <strong>&quot;{pageTitle}&quot;</strong> with you on PageSpace.
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>Your permissions:</strong> {permissions.join(', ')}
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Page
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because someone shared a page with you on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from page sharing notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
