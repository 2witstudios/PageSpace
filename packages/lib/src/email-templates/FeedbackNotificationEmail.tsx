import * as React from 'react';
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Section,
  Text,
} from '@react-email/components';
import { emailStyles } from './shared-styles';

interface FeedbackNotificationEmailProps {
  userId: string;
  message: string;
  pageUrl?: string;
  appVersion?: string;
  submittedAt: string;
  adminUrl: string;
}

export function FeedbackNotificationEmail({
  userId,
  message,
  pageUrl,
  appVersion,
  submittedAt,
  adminUrl,
}: FeedbackNotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>New Feedback Received</Text>
            <Text style={emailStyles.paragraph}>
              A user submitted feedback:
            </Text>
            <Section style={emailStyles.messageBox}>
              <Text style={emailStyles.messageText}>{message}</Text>
            </Section>
            <Text style={emailStyles.paragraph}>
              <strong>User ID:</strong> {userId}
              <br />
              <strong>Submitted:</strong> {submittedAt}
              {pageUrl && (
                <>
                  <br />
                  <strong>Page:</strong>{' '}
                  <Link href={pageUrl} style={emailStyles.link}>{pageUrl}</Link>
                </>
              )}
              {appVersion && (
                <>
                  <br />
                  <strong>App Version:</strong> {appVersion}
                </>
              )}
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              View all feedback in the{' '}
              <Link href={adminUrl} style={emailStyles.link}>admin dashboard</Link>.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
