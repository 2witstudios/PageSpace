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

interface ConnectionRequestEmailProps {
  userName: string;
  requesterName: string;
  requestMessage?: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function ConnectionRequestEmail({
  userName,
  requesterName,
  requestMessage,
  viewUrl,
  unsubscribeUrl,
}: ConnectionRequestEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>{requesterName} wants to connect</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{requesterName}</strong> wants to connect with you on PageSpace.
            </Text>
            {requestMessage && (
              <Section style={emailStyles.messageBox}>
                <Text style={emailStyles.messageText}>{requestMessage}</Text>
              </Section>
            )}
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Request
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because someone sent you a connection request on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from connection request notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
