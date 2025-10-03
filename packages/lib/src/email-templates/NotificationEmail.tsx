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
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Heading style={h1}>PageSpace</Heading>
          </Section>
          <Section style={content}>
            <Text style={heading}>{greeting}</Text>
            <Text style={paragraph}>{message}</Text>
            {actionUrl && actionText && (
              <Section style={buttonContainer}>
                <Button style={button} href={actionUrl}>
                  {actionText}
                </Button>
              </Section>
            )}
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              You&apos;re receiving this notification because you&apos;re part of a PageSpace workspace.
            </Text>
            {unsubscribeUrl && (
              <Text style={footerText}>
                <Link href={unsubscribeUrl} style={link}>
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

// Styles
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
};

const container = {
  margin: '0 auto',
  padding: '20px 0',
  maxWidth: '600px',
};

const header = {
  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  borderRadius: '10px 10px 0 0',
  padding: '30px',
  textAlign: 'center' as const,
};

const h1 = {
  color: '#ffffff',
  fontSize: '28px',
  fontWeight: '600',
  margin: '0',
};

const content = {
  backgroundColor: '#ffffff',
  padding: '40px 30px',
};

const heading = {
  fontSize: '20px',
  fontWeight: '600',
  color: '#333333',
  margin: '0 0 16px 0',
};

const paragraph = {
  fontSize: '16px',
  lineHeight: '24px',
  color: '#333333',
  margin: '0 0 24px 0',
};

const buttonContainer = {
  textAlign: 'center' as const,
  margin: '32px 0',
};

const button = {
  backgroundColor: '#667eea',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: '600',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 40px',
};

const footer = {
  backgroundColor: '#f8f9fa',
  borderRadius: '0 0 10px 10px',
  padding: '30px',
  borderTop: '1px solid #dddddd',
};

const footerText = {
  fontSize: '14px',
  color: '#666666',
  margin: '8px 0',
  textAlign: 'center' as const,
};

const link = {
  color: '#667eea',
  textDecoration: 'underline',
};
