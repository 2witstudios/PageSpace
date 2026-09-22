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

/**
 * Reports of objectionable content or abusive users (App Review Guideline 1.2).
 *
 * Stored alongside feedback, where support already triages, and emailed to the
 * same inbox so a report is seen without polling the admin console.
 */
const REPORT_EMAIL = process.env.CONTACT_EMAIL || 'hello@pagespace.ai';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const reportSchema = z.object({
  targetUserId: z.string().min(1).max(64),
  conversationId: z.string().min(1).max(64).optional(),
  reason: z.string().trim().min(1, 'Tell us what happened').max(2000),
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

    const validation = reportSchema.safeParse(await request.json());
    if (!validation.success) {
      return Response.json({ error: 'Validation failed', details: validation.error.flatten().fieldErrors }, { status: 400 });
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

    return Response.json({ message: 'Report received. Thank you.' }, { status: 201 });
  } catch (error) {
    loggers.api.error('Report submission error', error as Error);
    return Response.json({ error: 'An unexpected error occurred. Please try again later.' }, { status: 500 });
  }
}
