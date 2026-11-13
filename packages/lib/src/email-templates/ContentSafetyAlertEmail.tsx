import * as React from 'react';
import { Body, Container, Head, Heading, Html, Link, Section, Text } from '@react-email/components';
import { emailStyles } from './shared-styles';

/**
 * Alert to the abuse inbox about a content-safety case.
 *
 * The props are the whole of what this email can say: a case ID, a category,
 * a report count, what happened and a link to the admin console. There is
 * deliberately no prop for a filename, a file URL, a hash, a reported URL, the
 * reporter's own words or any content — email is forwarded,
 * indexed and previewed, and none of that may travel with it.
 */
export interface ContentSafetyAlertEmailProps {
  event: 'opened' | 'actioned' | 'awaiting_evidence' | 'resweep_failed' | 'report_opened' | 'report_added' | 'scan_flagged';
  caseId: string;
  category: string;
  /** Reports on the case so far. Report alerts only. */
  reportCount?: number;
  /** Link to the case in the admin console; omitted when no admin URL is configured. */
  adminUrl?: string;
}

const HEADLINES: Record<ContentSafetyAlertEmailProps['event'], string> = {
  opened: 'Content case opened',
  actioned: 'Content case actioned',
  awaiting_evidence: 'Content case is waiting for evidence storage',
  resweep_failed: 'Content case re-sweep failed',
  report_opened: 'New content report',
  report_added: 'Another report on a content case',
  scan_flagged: 'Publish scan flagged a file',
};

const EXPLANATIONS: Record<ContentSafetyAlertEmailProps['event'], string> = {
  opened: 'A content-safety case was opened and its takedown has started.',
  actioned: 'Every step of this case’s takedown has finished.',
  awaiting_evidence:
    'The content is blocked and can no longer be uploaded or served, but nothing has been deleted: this category must be preserved first and no evidence storage is configured. Configure EVIDENCE_BUCKET, then resume the case.',
  resweep_failed:
    'The follow-up pass over storage for this finished takedown did not complete, so late-arriving copies may still be in storage. The content stays blocked and cannot be served. The pass is retried automatically a limited number of times; if this keeps arriving, resume the case from the admin console.',
  report_opened:
    'Someone reported content and a case is waiting for review. Nothing has been taken down or blocked: review the case in the admin console.',
  report_added: 'Another report was filed on a case that is already waiting for review. Nothing has been taken down or blocked.',
  scan_flagged:
    'The publish scan’s classifier flagged a file someone tried to publish. It is a classifier score, not a confirmed match, so nothing has been blocked or taken down. In enforce mode the file was held back from the web; in shadow mode it was published. Review the case in the admin console.',
};

/** `urgent`: a CSAM report, which must be acted on immediately. The subject says so before anything else. */
export function contentSafetyAlertSubject(props: Pick<ContentSafetyAlertEmailProps, 'event' | 'caseId'> & { urgent?: boolean }): string {
  const subject = `[Content safety] ${HEADLINES[props.event]} (${props.caseId})`;
  if (!props.urgent) return subject;
  return props.event === 'scan_flagged' ? `[URGENT] Suspected CSAM: ${subject}` : `[URGENT] CSAM report: ${subject}`;
}

export function ContentSafetyAlertEmail({ event, caseId, category, reportCount, adminUrl }: ContentSafetyAlertEmailProps) {
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
              {reportCount !== undefined && (
                <>
                  <br />
                  <strong>Reports:</strong> {reportCount}
                </>
              )}
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
