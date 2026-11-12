/**
 * The web's wiring for content reports: the real dependencies of the lib
 * intake, bound to one request and (for a signed-in report) its actor.
 *
 * Same in every deployment mode: reports are local. On-prem the alert email is
 * a no-op (the email service sends nothing there) and is logged instead; the
 * case row is the record either way.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { files } from '@pagespace/db/schema/storage';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { sendContentSafetyAlert } from '@pagespace/lib/content-safety/alerts';
import { submitContentReport, type ReportIntakeDeps, type ReportOutcome, type ReportSubmission } from '@pagespace/lib/content-safety/report-intake';
import { fileContentReport, isRegisteredCustomDomain } from '@pagespace/lib/content-safety/report-store';
import { resolveTakedownTarget } from '@pagespace/lib/content-safety/targets';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { PUBLISH_HOST } from '@/lib/canvas/publish-page';

function intakeDeps(request: Request, actor: AccessActor | null): ReportIntakeDeps {
  return {
    publishHost: PUBLISH_HOST,
    resolveTarget: resolveTakedownTarget,
    isCustomDomainHost: isRegisteredCustomDomain,
    canViewPage: async (pageId) => (actor ? canUserViewPage(actor, pageId) : false),
    canAccessFile: async (fileId) => {
      if (!actor) return false;
      const [row] = await db.select({ id: files.id, driveId: files.driveId }).from(files).where(eq(files.id, fileId)).limit(1);
      return row ? canUserAccessFile(actor, row.id, row.driveId) : false;
    },
    fileReport: fileContentReport,
    alert: sendContentSafetyAlert,
    audit: (event) =>
      auditRequest(request, {
        eventType: event.eventType,
        userId: event.reporterUserId ?? undefined,
        resourceType: 'content_case',
        resourceId: event.caseId,
        // IDs and counts only: never the reporter's text, contact email or the URL they typed.
        details: { category: event.category, reportCount: event.reportCount, source: event.source, targetType: event.targetType },
        riskScore: event.category === 'csam' ? 0.9 : 0.5,
      }),
  };
}

/** File a report. `actor` is the signed-in reporter, or null for the public report page. */
export function fileReport(request: Request, actor: AccessActor | null, submission: ReportSubmission): Promise<ReportOutcome> {
  return submitContentReport(submission, intakeDeps(request, actor));
}
