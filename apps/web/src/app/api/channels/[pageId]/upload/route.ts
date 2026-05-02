import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  processAttachmentUpload,
  type AttachmentTarget,
} from '@pagespace/lib/services/attachment-upload';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * Channel file upload endpoint.
 *
 * Thin wrapper: validates that the page is a channel the caller can edit, then
 * delegates to the polymorphic upload pipeline. Quota, semaphore, dedup, audit,
 * and storage accounting live in @pagespace/lib/services/attachment-upload so
 * channel and DM uploads share a single code path.
 *
 * Wrapper-stage awaits (auth, page lookup, permission check) are wrapped in
 * try/catch so unexpected failures still return the structured `{ error }`
 * JSON contract instead of bubbling as framework HTML errors.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    const channelPage = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!channelPage) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    if (channelPage.type !== 'CHANNEL') {
      return NextResponse.json({ error: 'Not a channel' }, { status: 400 });
    }
    if (!channelPage.driveId) {
      return NextResponse.json({ error: 'Channel has no associated drive' }, { status: 400 });
    }

    const canEdit = await canUserEditPage(auth.userId, pageId);
    if (!canEdit) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        resourceType: 'channel_upload',
        resourceId: pageId,
      });
      return NextResponse.json(
        { error: 'You need edit permission to upload files in this channel' },
        { status: 403 }
      );
    }

    const target: AttachmentTarget = {
      type: 'page',
      pageId,
      driveId: channelPage.driveId,
    };

    return processAttachmentUpload({ request, target, userId: auth.userId });
  } catch (error) {
    loggers.api.error('Channel upload wrapper error', error as Error, { pageId });
    return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
