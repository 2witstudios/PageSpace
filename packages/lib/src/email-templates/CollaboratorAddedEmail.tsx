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

interface CollaboratorAddedEmailProps {
  userName: string;
  adderName: string;
  pageTitle: string;
  viewUrl: string;
  unsubscribeUrl?: string;
}

export function CollaboratorAddedEmail({
  userName,
  adderName,
  pageTitle,
  viewUrl,
  unsubscribeUrl,
}: CollaboratorAddedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>You can now edit &quot;{pageTitle}&quot;</Text>
            <Text style={emailStyles.paragraph}>
              Hi {userName},
            </Text>
            <Text style={emailStyles.paragraph}>
              <strong>{adderName}</strong> added you as a collaborator on <strong>&quot;{pageTitle}&quot;</strong>.
            </Text>
            <Text style={emailStyles.paragraph}>
              You now have edit access and can make changes to this page.
            </Text>
            <Section style={emailStyles.buttonContainer}>
              <Button style={emailStyles.button} href={viewUrl}>
                Start Editing
              </Button>
            </Section>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              You&apos;re receiving this email because someone added you as a collaborator on PageSpace.
            </Text>
            {unsubscribeUrl && (
              <Text style={emailStyles.footerText}>
                <Link href={unsubscribeUrl} style={emailStyles.link}>
                  Unsubscribe from collaborator notifications
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
