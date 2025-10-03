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

interface NotificationEmailProps {
  userName: string;
  subject: string;
  greeting: string;
  message: string;
  actionUrl?: string;
  actionText?: string;
  unsubscribeUrl?: string;
}

export function NotificationEmail({
  userName,
  subject,
  greeting,
  message,
  actionUrl,
  actionText,
  unsubscribeUrl,
}: NotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>{greeting}</Text>
            <Text style={emailStyles.paragraph}>{message}</Text>
            {actionUrl && actionText && (
              <Section style={emailStyles.buttonContainer}>
                <Button style={emailStyles.button} href={actionUrl}>
                  {actionText}
                </Button>
              </Section>
            )}
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this notification because you&apos;re part of a PageSpace workspace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from this notification type
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
