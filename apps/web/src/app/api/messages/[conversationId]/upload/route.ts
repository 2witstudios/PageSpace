import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { dmConversations } from '@pagespace/db/schema/social';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  processAttachmentUpload,
  type AttachmentTarget,
} from '@pagespace/lib/services/attachment-upload';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * DM file upload endpoint.
 *
 * Thin wrapper that validates the conversation exists and the caller's email
 * is verified, then delegates to the polymorphic upload pipeline. Quota,
 * semaphore, dedup, audit, storage accounting, and participant authorization
 * live in @pagespace/lib/services/attachment-upload — the participant check is
 * intentionally NOT duplicated here so the pipeline remains the single source
 * of truth for DM access control.
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    const conversation = await db.query.dmConversations.findFirst({
      where: eq(dmConversations.id, conversationId),
    });

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const emailVerified = await isEmailVerified(auth.userId);
    if (!emailVerified) {
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

    return await processAttachmentUpload({ request, target, userId: auth.userId });
  } catch (error) {
    loggers.api.error('DM upload wrapper error', error as Error, { conversationId });
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
