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

interface DriveRoleChangedEmailProps {
  userName: string;
  driveName: string;
  newRole: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function DriveRoleChangedEmail({
  userName,
  driveName,
  newRole,
  viewUrl,
  unsubscribeUrl,
}: DriveRoleChangedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Your role has been updated</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              Your role in <strong>{driveName}</strong> has been changed to <strong>{newRole}</strong>.
            </Text>
            <Text style={emailStyles.paragraph}>
              Your permissions and access levels have been updated accordingly.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                View Workspace
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because your role was changed in a workspace on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from workspace notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
