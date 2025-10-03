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

interface PermissionUpdatedEmailProps {
  userName: string;
  pageTitle: string;
  permissions: string[];
  driveName?: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function PermissionUpdatedEmail({
  userName,
  pageTitle,
  permissions,
  driveName,
  viewUrl,
  unsubscribeUrl,
}: PermissionUpdatedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Permissions updated</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              Your permissions for <strong>&quot;{pageTitle}&quot;</strong>{driveName && ` in ${driveName}`} have been updated.
            </Text>
            <Text style={emailStyles.paragraph}>
              You now have <strong>{permissions.join(', ')}</strong> access to this page.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Page
              </Button>
            </Section>
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
