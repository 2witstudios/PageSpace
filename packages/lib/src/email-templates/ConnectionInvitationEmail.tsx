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

interface ConnectionInvitationEmailProps {
  recipientEmail: string;
  inviterName: string;
  message?: string;
  acceptUrl: string;
}

export function ConnectionInvitationEmail({
  recipientEmail,
  inviterName,
  message,
  acceptUrl,
}: ConnectionInvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>
              {inviterName} wants to connect with you
            </Text>
            <Text style={emailStyles.paragraph}>
              Hi {recipientEmail},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{inviterName}</strong> would like to connect with you on PageSpace — a platform where people and AI agents collaborate in shared workspaces.
            </Text>
            {message && (
              <Section style={emailStyles.messageBox}>
                <Text style={emailStyles.messageText}>&ldquo;{message}&rdquo;</Text>
              </Section>
            )}
            <Text style={emailStyles.paragraph}>
              Create your account and accept the connection invite.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={acceptUrl}>
                Accept and Join PageSpace
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
              You received this because {inviterName} sent you a connection invite on PageSpace.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
