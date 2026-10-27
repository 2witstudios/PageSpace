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

interface OrgInvitationEmailProps {
  userName: string;
  inviterName: string;
  orgName: string;
  roleLabel: string;
  expiresInDays: number;
  acceptUrl: string;
}

export function OrgInvitationEmail({
  userName,
  inviterName,
  orgName,
  roleLabel,
  expiresInDays,
  acceptUrl,
}: OrgInvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>You&apos;re invited to join an organization</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{inviterName}</strong> invited you to join <strong>&quot;{orgName}&quot;</strong> on PageSpace as {roleLabel}.
            </Text>
            <Text style={emailStyles.paragraph}>
              Accept with an existing PageSpace account for this address, or create one. This invitation expires in {expiresInDays} days.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={acceptUrl}>
                Accept Invitation
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={acceptUrl} style={emailStyles.link}>
                {acceptUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because you were invited to a PageSpace organization.
            </Text>
            <Text style={emailStyles.footerText}>
              PageSpace received your email address from {inviterName} to send you this invitation
              — see our{' '}
              <Link href="https://pagespace.ai/privacy" style={emailStyles.link}>
                Privacy Policy
              </Link>{' '}
              for details.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
