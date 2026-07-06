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
import { STEP_UP_MAGIC_LINK_EXPIRY_MINUTES } from '../auth/step-up-constants';

interface StepUpConfirmationEmailProps {
  confirmUrl: string;
}

export function StepUpConfirmationEmail({ confirmUrl }: StepUpConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Confirm this action</Text>
            <Text style={emailStyles.paragraph}>
              Someone requested a sensitive action on your PageSpace account that needs your live
              confirmation. Click the button below to confirm it&apos;s you. This link will expire
              in {STEP_UP_MAGIC_LINK_EXPIRY_MINUTES} minutes and can only be used once.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={confirmUrl}>
                Confirm This Action
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={confirmUrl} style={emailStyles.link}>
                {confirmUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              If you didn&apos;t request this, do not click the link — someone else may be trying
              to act on your account. Your account is still safe; just ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
