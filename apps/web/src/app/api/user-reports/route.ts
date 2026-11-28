import { db } from '@pagespace/db/db';
import { feedbackSubmissions } from '@pagespace/db/schema/feedback';
import { z } from 'zod/v4';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { FeedbackNotificationEmail } from '@pagespace/lib/email-templates/FeedbackNotificationEmail';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { signedInReportSchema } from '@pagespace/lib/content-safety/reports';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { fileReport } from '@/lib/content-safety/report-service';
import { reportResponse } from '@/lib/content-safety/report-response';

/**
 * Reports of objectionable content or abusive users (App Review Guideline 1.2).
 *
 * Two shapes:
 * - `{ targetUserId, conversationId?, reason }` — a user report, as the app's
 *   safety menu sends it. Stored alongside feedback, where support already
 *   triages, and emailed to the same inbox; it ALSO opens (or joins) a content
 *   case about that user, so it shows in the admin review queue.
 * - `{ target, category, description? }` — a report about a page, file, user or
 *   published URL. It goes only to a content case: never to the feedback inbox,
 *   and its text is never emailed. The reporter must be able to see a page or
 *   file; a refusal does not say whether it exists.
 *
 * A report never takes anything down or blocks it. Staff review it.
 */
const REPORT_EMAIL = process.env.CONTACT_EMAIL || 'hello@pagespace.ai';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const reportSchema = z.object({
  targetUserId: z.string().min(1).max(64),
  conversationId: z.string().min(1).max(64).optional(),
  reason: z.string().trim().min(1, 'Tell us what happened').max(2000),
  // A body that names a `target` is a content report: if that one is invalid, it is refused, never read as this shape.
  target: z.never().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const rateLimit = await checkDistributedRateLimit(`report:${userId}`, DISTRIBUTED_RATE_LIMITS.CONTACT_FORM);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Too many reports. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter || 3600) } },
      );
    }

    const body: unknown = await request.json();
    const contentReport = signedInReportSchema.safeParse(body);
    if (contentReport.success) {
      const outcome = await fileReport(request, actorFromAuth(auth), {
        reporter: { kind: 'user', userId },
        target: contentReport.data.target,
        category: contentReport.data.category,
        description: contentReport.data.description,
      });
      return reportResponse(outcome);
    }

    const validation = reportSchema.safeParse(body);
    if (!validation.success) {
      // Name the content-report problems when the body named a target; the user-report ones otherwise.
      const namedTarget = validation.error.issues.some((issue) => issue.path[0] === 'target');
      const details = (namedTarget ? contentReport.error : validation.error).flatten().fieldErrors;
      return Response.json({ error: 'Validation failed', details }, { status: 400 });
    }
    const { targetUserId, conversationId, reason } = validation.data;
    if (targetUserId === userId) {
      return Response.json({ error: 'You cannot report yourself' }, { status: 400 });
    }

    const message = `[Report] Reported user ${targetUserId}${conversationId ? ` in conversation ${conversationId}` : ''}: ${reason}`;
    const pageUrl = conversationId ? `/dashboard/dms/${conversationId}` : null;
    const reportId = createId();

    await db.insert(feedbackSubmissions).values({ id: reportId, userId, message, pageUrl });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'user_report', resourceId: targetUserId, details: { reportId, hasConversation: !!conversationId } });

    try {
      const appUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      await sendEmail({
        to: REPORT_EMAIL,
        subject: `[PageSpace Report] User ${targetUserId} reported`,
        react: FeedbackNotificationEmail({
          userId,
          message,
          pageUrl: pageUrl ?? undefined,
          submittedAt: new Date().toISOString(),
          adminUrl: `${appUrl}/admin/support`,
        }),
      });
    } catch (emailError) {
      loggers.api.error('Failed to send report notification email', emailError as Error);
    }

    // The same report, as a content case for the review queue. Best-effort: the
    // feedback row above is this flow's record, as it always was.
    try {
      await fileReport(request, actorFromAuth(auth), {
        reporter: { kind: 'user', userId },
        target: { type: 'user', userId: targetUserId },
        category: 'harassment',
        description: reason,
      });
    } catch (caseError) {
      loggers.api.error('Failed to open a content case for a user report', caseError as Error);
    }

    return Response.json({ message: 'Report received. Thank you.' }, { status: 201 });
  } catch (error) {
    loggers.api.error('Report submission error', error as Error);
    return Response.json({ error: 'An unexpected error occurred. Please try again later.' }, { status: 500 });
  }
}
