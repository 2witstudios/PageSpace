import * as React from 'react';
import { Body, Container, Head, Heading, Html, Link, Section, Text } from '@react-email/components';
import { emailStyles } from './shared-styles';

/**
 * Alert to the abuse inbox about a content-safety case.
 *
 * The props are the whole of what this email can say: a case ID, a category,
 * what happened and a link to the admin console. There is deliberately no prop
 * for a filename, a file URL, a hash or any content — email is forwarded,
 * indexed and previewed, and none of that may travel with it.
 */
export interface ContentSafetyAlertEmailProps {
  event: 'opened' | 'actioned' | 'awaiting_evidence';
  caseId: string;
  category: string;
  /** Link to the case in the admin console; omitted when no admin URL is configured. */
  adminUrl?: string;
}

const HEADLINES: Record<ContentSafetyAlertEmailProps['event'], string> = {
  opened: 'Content case opened',
  actioned: 'Content case actioned',
  awaiting_evidence: 'Content case is waiting for evidence storage',
};

const EXPLANATIONS: Record<ContentSafetyAlertEmailProps['event'], string> = {
  opened: 'A content-safety case was opened and its takedown has started.',
  actioned: 'Every step of this case’s takedown has finished.',
  awaiting_evidence:
    'The content is blocked and can no longer be uploaded or served, but nothing has been deleted: this category must be preserved first and no evidence storage is configured. Configure EVIDENCE_BUCKET, then resume the case.',
};

export function contentSafetyAlertSubject(props: Pick<ContentSafetyAlertEmailProps, 'event' | 'caseId'>): string {
  return `[Content safety] ${HEADLINES[props.event]} (${props.caseId})`;
}

export function ContentSafetyAlertEmail({ event, caseId, category, adminUrl }: ContentSafetyAlertEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={emailStyles.main}>
        <Container style={emailStyles.container}>
          <Section style={emailStyles.header}>
            <Heading style={emailStyles.headerTitle}>PageSpace</Heading>
          </Section>
          <Section style={emailStyles.content}>
            <Text style={emailStyles.contentHeading}>{HEADLINES[event]}</Text>
            <Text style={emailStyles.paragraph}>{EXPLANATIONS[event]}</Text>
            <Text style={emailStyles.paragraph}>
              <strong>Case:</strong> {caseId}
              <br />
              <strong>Category:</strong> {category}
            </Text>
            {adminUrl && (
              <Text style={emailStyles.paragraph}>
                <Link href={adminUrl} style={emailStyles.link}>
                  Open the case in the admin console
                </Link>
              </Text>
            )}
            <Text style={emailStyles.paragraph}>
              Do not open, download or forward the reported material. Follow the runbook.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
