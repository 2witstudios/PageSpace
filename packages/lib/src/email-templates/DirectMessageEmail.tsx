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

interface DirectMessageEmailProps {
  userName: string;
  senderName: string;
  messagePreview: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function DirectMessageEmail({
  userName,
  senderName,
  messagePreview,
  viewUrl,
  unsubscribeUrl,
}: DirectMessageEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>New message from {senderName}</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{senderName}</strong> sent you a message:
            </Text>
            <Section style={emailStyles.messageBox}>
              <Text style={emailStyles.messageText}>{messagePreview}</Text>
            </Section>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Message
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because someone sent you a direct message on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from direct message notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
