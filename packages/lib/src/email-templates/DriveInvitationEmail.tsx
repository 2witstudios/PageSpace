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

interface DriveInvitationEmailProps {
  userName: string;
  inviterName: string;
  driveName: string;
  acceptUrl: string;
  unsubscribeUrl?: string;
}

export function DriveInvitationEmail({
  userName,
  inviterName,
  driveName,
  acceptUrl,
  unsubscribeUrl,
}: DriveInvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>You&apos;ve been invited to a workspace</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{inviterName}</strong> has invited you to join the <strong>&quot;{driveName}&quot;</strong> workspace on PageSpace.
            </Text>
            <Text style={emailStyles.paragraph}>
              Join the workspace to collaborate on pages, share documents, and work together with your team.
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
              You&apos;re receiving this email because someone invited you to join their PageSpace workspace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from drive invitations
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
