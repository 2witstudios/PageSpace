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
import { emailStyles, spacing } from './shared-styles';

interface VerificationEmailProps {
  userName: string;
  verificationUrl: string;
}

export function VerificationEmail({ userName, verificationUrl }: VerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Welcome to PageSpace!</Text>
            <Text style={emailStyles.paragraph}>Hi {userName},</Text>
            <Text style={emailStyles.paragraph}>
              Thanks for signing up! Please verify your email address to complete your account setup.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={verificationUrl}>
                Verify Email Address
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={verificationUrl} style={emailStyles.link}>
                {verificationUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              This link will expire in 24 hours. If you didn&apos;t create a PageSpace account, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
