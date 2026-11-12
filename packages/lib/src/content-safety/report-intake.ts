/**
 * Content report intake: check a report's target, file it on the case under
 * review for that target, alert the abuse inbox and audit it.
 *
 * Every effect is a dependency, so the rules here are tested without a
 * database. A report NEVER acts on content: there is deliberately no takedown,
 * block or unpublish dependency. Staff decide, from the admin console.
 *
 * Refusals are neutral. A page that does not exist and one the reporter cannot
 * see get the same answer, and the reporter is never told anything about the
 * target beyond "received".
 */

import type { ContentCaseTargetType, ContentReportCategory, ContentReportSource } from '@pagespace/db/schema/content-safety';
import { loggers } from '../logging/logger-config';
import { CSAM_REPORT_GUIDANCE, classifyReportUrl, type CsamReportGuidance, type ReportTargetInput } from './reports';
import type { ResolvedTarget } from './targets';

export type Reporter = { kind: 'user'; userId: string } | { kind: 'anonymous'; contactEmail?: string };

export interface ReportSubmission {
  reporter: Reporter;
  target: ReportTargetInput;
  category: ContentReportCategory;
  description?: string;
}

/** What the store files: the resolved target, never the URL the reporter typed. */
export interface FileReportInput {
  target: { targetType: ContentCaseTargetType; targetId: string; contentHash: string | null };
  category: ContentReportCategory;
  description: string | null;
  source: ContentReportSource;
  reporterUserId: string | null;
  contactEmail: string | null;
}

export interface FiledReport {
  caseId: string;
  /** True when this report opened the case; false when it joined the one under review. */
  created: boolean;
  reportCount: number;
}

/** Alert for a report. Case ID, category and count only — never the URL, a filename or the reporter's words. */
export interface ReportAlert {
  event: 'report_opened' | 'report_added';
  caseId: string;
  category: ContentReportCategory;
  reportCount: number;
}

export interface ReportAuditEvent {
  eventType: 'content.report.created' | 'content.report.attached';
  caseId: string;
  category: ContentReportCategory;
  reportCount: number;
  source: ContentReportSource;
  reporterUserId: string | null;
  targetType: ContentCaseTargetType;
}

export interface ReportIntakeDeps {
  /** The root publish hostname, e.g. `pagespace.site`. */
  publishHost: string;
  resolveTarget(input: string): Promise<ResolvedTarget | null>;
  /** Is this hostname a custom domain attached to one of our drives? */
  isCustomDomainHost(host: string): Promise<boolean>;
  /** Permission checks for the signed-in reporter. Never called for an anonymous report. */
  canViewPage(pageId: string): Promise<boolean>;
  canAccessFile(fileId: string): Promise<boolean>;
  fileReport(input: FileReportInput): Promise<FiledReport>;
  /** Throws on failure; the intake logs it and keeps the report. */
  alert(alert: ReportAlert): Promise<void>;
  audit(event: ReportAuditEvent): void;
}

export type ReportRefusal = 'not_pagespace_url' | 'not_found' | 'self_report';

export type ReportOutcome =
  | { ok: true; caseId: string; created: boolean; reportCount: number; csamGuidance: CsamReportGuidance | null }
  | { ok: false; reason: ReportRefusal };

type Resolution = { ok: true; target: ResolvedTarget } | { ok: false; reason: ReportRefusal };

const refuse = (reason: ReportRefusal): { ok: false; reason: ReportRefusal } => ({ ok: false, reason });

async function resolvePublishedUrl(raw: string, deps: ReportIntakeDeps): Promise<Resolution> {
  const classified = classifyReportUrl(raw, deps.publishHost);
  if (!classified) return refuse('not_pagespace_url');
  // Confirm a custom domain before resolving: the resolver also tries a host's first label as a subdomain,
  // which would let `acme.evil.test` name the drive published at `acme.<publish host>`.
  if (classified.kind === 'custom_domain_candidate' && !(await deps.isCustomDomainHost(classified.host))) {
    return refuse('not_pagespace_url');
  }
  const resolved = await deps.resolveTarget(classified.url);
  // A host of ours with nothing published there gets the same answer as a host that is not ours.
  return resolved ? { ok: true, target: resolved } : refuse('not_pagespace_url');
}

async function resolveSubmissionTarget(submission: ReportSubmission, deps: ReportIntakeDeps): Promise<Resolution> {
  const { target, reporter } = submission;
  if (target.type === 'published_url') return resolvePublishedUrl(target.url, deps);

  // Anything other than a public URL needs a signed-in reporter who can see it.
  if (reporter.kind !== 'user') return refuse('not_found');

  switch (target.type) {
    case 'page': {
      if (!(await deps.canViewPage(target.pageId))) return refuse('not_found');
      const resolved = await deps.resolveTarget(target.pageId);
      return resolved?.targetType === 'page' ? { ok: true, target: resolved } : refuse('not_found');
    }
    case 'file': {
      if (!(await deps.canAccessFile(target.fileId))) return refuse('not_found');
      const resolved = await deps.resolveTarget(target.fileId);
      // A file whose ID is its content hash resolves to the hash: reports about the same bytes share a case.
      return resolved && (resolved.targetType === 'file' || resolved.targetType === 'content_hash')
        ? { ok: true, target: resolved }
        : refuse('not_found');
    }
    case 'user': {
      if (target.userId === reporter.userId) return refuse('self_report');
      const resolved = await deps.resolveTarget(target.userId);
      return resolved?.targetType === 'user' ? { ok: true, target: resolved } : refuse('not_found');
    }
  }
}

export async function submitContentReport(submission: ReportSubmission, deps: ReportIntakeDeps): Promise<ReportOutcome> {
  const resolution = await resolveSubmissionTarget(submission, deps);
  if (!resolution.ok) return resolution;
  const { target } = resolution;

  const source: ContentReportSource = submission.reporter.kind === 'user' ? 'signed_in' : 'anonymous';
  const reporterUserId = submission.reporter.kind === 'user' ? submission.reporter.userId : null;
  const contactEmail = submission.reporter.kind === 'anonymous' ? (submission.reporter.contactEmail ?? null) : null;

  const filed = await deps.fileReport({
    target: { targetType: target.targetType, targetId: target.targetId, contentHash: target.contentHash },
    category: submission.category,
    description: submission.description ? submission.description : null,
    source,
    reporterUserId,
    contactEmail,
  });

  deps.audit({
    eventType: filed.created ? 'content.report.created' : 'content.report.attached',
    caseId: filed.caseId,
    category: submission.category,
    reportCount: filed.reportCount,
    source,
    reporterUserId,
    targetType: target.targetType,
  });

  try {
    await deps.alert({
      event: filed.created ? 'report_opened' : 'report_added',
      caseId: filed.caseId,
      category: submission.category,
      reportCount: filed.reportCount,
    });
  } catch (error) {
    // The case row is the record; a lost email must not lose the report.
    loggers.security.error('Content report alert failed', error instanceof Error ? error : undefined, { caseId: filed.caseId });
  }

  return {
    ok: true,
    caseId: filed.caseId,
    created: filed.created,
    reportCount: filed.reportCount,
    csamGuidance: submission.category === 'csam' ? CSAM_REPORT_GUIDANCE : null,
  };
}
