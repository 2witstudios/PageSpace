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

interface DomainVerificationEmailProps {
  orgName: string;
  domain: string;
  expiresInHours: number;
  verifyUrl: string;
}

export function DomainVerificationEmail({ orgName, domain, expiresInHours, verifyUrl }: DomainVerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>Confirm that {domain} belongs to {orgName}</Text>
            <Text style={emailStyles.paragraph}>
              The organization <strong>&quot;{orgName}&quot;</strong> on PageSpace asked to verify the email domain{' '}
              <strong>{domain}</strong>. This message went to an administrative mailbox for the domain.
            </Text>
            <Text style={emailStyles.paragraph}>
              Once verified, new PageSpace accounts with a verified {domain} address join {orgName} as members
              automatically, while it has seats. Only confirm if you manage this domain for that organization.
              This link expires in {expiresInHours} hours.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={verifyUrl}>
                Verify {domain}
              </Button>
            </Section>
            <Text style={emailStyles.hint}>
              Or copy and paste this link into your browser:
              <br />
              <Link href={verifyUrl} style={emailStyles.link}>
                {verifyUrl}
              </Link>
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              If you did not expect this, ignore it: nothing changes unless the link is used.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
