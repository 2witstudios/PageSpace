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

interface ConnectionAcceptedEmailProps {
  userName: string;
  accepterName: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function ConnectionAcceptedEmail({
  userName,
  accepterName,
  viewUrl,
  unsubscribeUrl,
}: ConnectionAcceptedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>{accepterName} accepted your connection request</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              Great news! <strong>{accepterName}</strong> has accepted your connection request on PageSpace.
            </Text>
            <Text style={emailStyles.paragraph}>
              You can now collaborate on pages, share content, and communicate directly.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Connection
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because someone accepted your connection request on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from connection notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
