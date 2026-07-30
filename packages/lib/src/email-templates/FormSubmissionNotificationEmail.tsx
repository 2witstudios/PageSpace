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

export interface FormSubmissionEntry {
  label: string;
  value: string;
}

interface FormSubmissionNotificationEmailProps {
  submittedAt: string;
  entries: FormSubmissionEntry[];
  sheetUrl: string;
}

export function FormSubmissionNotificationEmail({
  entries,
  submittedAt,
  sheetUrl,
}: FormSubmissionNotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>New Form Submission</Text>
            <Text style={emailStyles.paragraph}>
              Someone submitted your form.
            </Text>
            {entries.map((entry) => (
              <Section key={entry.label} style={emailStyles.messageBox}>
                <Text style={emailStyles.messageText}>
                  <strong>{entry.label}:</strong> {entry.value}
                </Text>
              </Section>
            ))}
            <Text style={emailStyles.hint}>
              Submitted: {submittedAt}
            </Text>
          </Section>
          <Section style={emailStyles.footer}>
            <Text style={emailStyles.footerText}>
              View all submissions in the{' '}
              <Link href={sheetUrl} style={emailStyles.link}>response sheet</Link>.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}