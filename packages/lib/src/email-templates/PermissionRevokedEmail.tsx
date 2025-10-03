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

interface PermissionRevokedEmailProps {
  userName: string;
  pageTitle: string;
  driveName?: string;
  unsubscribeUrl?: string;
}

export function PermissionRevokedEmail({
  userName,
  pageTitle,
  driveName,
  unsubscribeUrl,
}: PermissionRevokedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Access removed</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              Your access to <strong>&quot;{pageTitle}&quot;</strong>{driveName && ` in ${driveName}`} has been removed.
            </Text>
            <Text style={emailStyles.paragraph}>
              You will no longer be able to view or edit this page.
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because your page permissions were changed on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from permission notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
