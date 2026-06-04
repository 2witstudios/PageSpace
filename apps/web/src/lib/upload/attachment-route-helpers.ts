import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { and, eq, or } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { dmConversations } from '@pagespace/db/schema/social';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import type { AttachmentTarget } from '@pagespace/lib/services/attachment-upload-core';

/**
 * Shared auth + target-resolution for the direct-to-S3 attachment routes
 * (presign/complete/cancel × channel/DM). Each resolver reproduces the exact
 * authorization the legacy multipart POST routes enforced, so the six thin
 * presign/complete/cancel handlers stay free of duplicated gate logic.
 */

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export type Resolved =
  | { ok: true; ctx: EnforcedAuthContext; target: AttachmentTarget }
  | { ok: false; response: NextResponse };

export type AuthOnly =
  | { ok: true; ctx: EnforcedAuthContext }
  | { ok: false; response: NextResponse };

/** Session + CSRF only — for cancel, where the slot is user-owned (no target gate). */
export async function authenticateAttachmentRequest(request: Request): Promise<AuthOnly> {
  const auth = await authenticateWithEnforcedContext(request, AUTH_OPTIONS);
  if (isEnforcedAuthError(auth)) {
    return { ok: false, response: auth.error };
  }
  return { ok: true, ctx: auth.ctx };
}

/** Channel upload: page must be a CHANNEL with a drive the caller can edit. */
export async function resolveChannelTarget(request: Request, pageId: string): Promise<Resolved> {
  const auth = await authenticateAttachmentRequest(request);
  if (!auth.ok) return auth;
  const { ctx } = auth;

  const channelPage = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
  if (!channelPage) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }
  if (channelPage.type !== 'CHANNEL') {
    return { ok: false, response: NextResponse.json({ error: 'Not a channel' }, { status: 400 }) };
  }
  if (!channelPage.driveId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel has no associated drive' }, { status: 400 }) };
  }

  const canEdit = await canUserEditPage(ctx.userId, pageId);
  if (!canEdit) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: ctx.userId,
      resourceType: 'channel_upload',
      resourceId: pageId,
    });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'You need edit permission to upload files in this channel' },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx, target: { type: 'page', pageId, driveId: channelPage.driveId } };
}

/** DM upload: caller must be a participant and email-verified. */
export async function resolveConversationTarget(request: Request, conversationId: string): Promise<Resolved> {
  const auth = await authenticateAttachmentRequest(request);
  if (!auth.ok) return auth;
  const { ctx } = auth;

  // Scope to participant so non-participants and non-existent conversations are
  // indistinguishable (both 404), preventing conversation-id enumeration.
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
    return { ok: false, response: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };
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
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx, target: { type: 'conversation', conversationId } };
}
