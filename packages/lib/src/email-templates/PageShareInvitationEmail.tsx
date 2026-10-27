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

interface PageShareInvitationEmailProps {
  inviterName: string;
  pageTitle: string;
  driveName: string;
  permissions: string[];
  acceptUrl: string;
}

export function PageShareInvitationEmail({
  inviterName,
  pageTitle,
  driveName,
  permissions,
  acceptUrl,
}: PageShareInvitationEmailProps) {
  const permissionList = permissions.join(', ');

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
              You&apos;ve been invited to view a document
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{inviterName}</strong> shared the document{' '}
              <strong>&quot;{pageTitle}&quot;</strong> with you on PageSpace.
            </Text>
            <Text style={emailStyles.paragraph}>
              You have been granted the following permissions:{' '}
              <strong>{permissionList}</strong>.
            </Text>
            <Text style={emailStyles.paragraph}>
              This document is part of the <strong>{driveName}</strong> workspace.
              Create a free account to access it.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={acceptUrl}>
                Accept &amp; View Document
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
              You&apos;re receiving this email because someone shared a PageSpace document with you.
              If you did not expect this, you can safely ignore it.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
