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

interface MagicLinkEmailProps {
  magicLinkUrl: string;
}

export function MagicLinkEmail({ magicLinkUrl }: MagicLinkEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Sign in to PageSpace</Text>
            <Text style={emailStyles.paragraph}>
              Click the button below to sign in to your account. This link will expire in 5 minutes.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={magicLinkUrl}>
                Sign In to PageSpace
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={magicLinkUrl} style={emailStyles.link}>
                {magicLinkUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              This link expires in 5 minutes. If you didn&apos;t request this sign-in link, you can safely ignore this email - someone may have entered your email address by mistake.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
