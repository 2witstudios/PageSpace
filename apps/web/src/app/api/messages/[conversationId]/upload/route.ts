import { NextRequest, NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { and, eq, or } from '@pagespace/db/operators';
import { dmConversations } from '@pagespace/db/schema/social';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  processAttachmentUploads,
  type AttachmentTarget,
} from '@pagespace/lib/services/attachment-upload';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * DM file upload endpoint.
 *
 * Thin wrapper that scopes the conversation lookup to the calling participant
 * (mirroring `apps/web/src/app/api/messages/[conversationId]/route.ts`), enforces
 * the email-verification gate, then delegates to the polymorphic upload pipeline.
 * Quota, semaphore, dedup, audit, storage accounting, and authoritative
 * participant authorization live in @pagespace/lib/services/attachment-upload —
 * the wrapper's participant-scoped lookup is purely defensive (it both prevents
 * existence enumeration via the 404/403 status split and avoids any pipeline
 * work for non-participants); the pipeline still owns the canonical access check.
 *
 * Wrapper-stage awaits (auth, conversation lookup, email-verify) are wrapped in
 * try/catch so unexpected failures still return the structured `{ error }`
 * JSON contract instead of bubbling as framework HTML errors.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await context.params;

  try {
    const auth = await authenticateWithEnforcedContext(request, AUTH_OPTIONS);
    if (isEnforcedAuthError(auth)) {
      return auth.error;
    }
    const { ctx } = auth;

    // Scope to participant so non-participants and non-existent conversations are
    // indistinguishable from the outside (both return 404). This matches the
    // existing DM message routes and prevents conversation-id enumeration.
    const conversation = await db.query.dmConversations.findFirst({
      where: and(
          eq(dmConversations.id, conversationId),
        or(
          eq(dmConversations.participant1Id, ctx.userId),
          eq(dmConversations.participant2Id, ctx.userId),
        ),
      ),
    });

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const emailVerified = await isEmailVerified(ctx.userId);
    if (!emailVerified) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: ctx.userId,
        resourceType: 'dm_upload',
        resourceId: conversationId,
        details: { reason: 'email_not_verified' },
      });
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 }
      );
    }

    const target: AttachmentTarget = {
      type: 'conversation',
      conversationId,
    };

    return await processAttachmentUploads({ request, target, authContext: ctx });
  } catch (error) {
    loggers.api.error('DM upload wrapper error', error as Error, { conversationId });
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
