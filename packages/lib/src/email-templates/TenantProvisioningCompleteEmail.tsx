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

interface TenantProvisioningCompleteEmailProps {
  adminEmail: string;
  loginUrl: string;
  temporaryPassword?: string;
}

export function TenantProvisioningCompleteEmail({
  adminEmail,
  loginUrl,
  temporaryPassword,
}: TenantProvisioningCompleteEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Your environment is ready!</Text>
            <Text style={emailStyles.paragraph}>
              Your PageSpace environment has been provisioned and is ready to use.
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>Login email:</strong> {adminEmail}
            </Text>
            {temporaryPassword && (
              <Text style={emailStyles.paragraph}>
                <strong>Temporary password:</strong> {temporaryPassword}
                <br />
                Please change your password after your first login.
              </Text>
            )}
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={loginUrl}>
                Sign In to Your Environment
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={loginUrl} style={emailStyles.link}>
                {loginUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              This is a one-time provisioning email from PageSpace.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
