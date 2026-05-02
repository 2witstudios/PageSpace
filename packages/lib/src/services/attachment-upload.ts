/**
 * Polymorphic attachment upload pipeline.
 *
 * Channel uploads (target.type === 'page') and DM uploads (target.type === 'conversation')
 * share quota, semaphore, dedup, and audit logic. The route layer constructs an
 * AttachmentTarget and delegates here; differences between page and conversation flows
 * (token resource binding, file row driveId, linkage table) are concentrated in this module.
 *
 * @module @pagespace/lib/services/attachment-upload
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { dmConversations } from '@pagespace/db/schema/social';
import { sessionService } from '../auth/session-service';
import { loggers } from '../logging/logger-config';
import {
  createUploadServiceToken,
  PermissionDeniedError,
  type ServiceScope,
} from './validated-service-token';

/**
 * Upload destination — discriminated by target type.
 *
 * - `page`: channel page in a drive. Files get a real driveId and a `file_pages` linkage.
 * - `conversation`: DM conversation outside any drive. Files have null driveId and a
 *   `file_conversations` linkage; access is governed by participant membership.
 */
export type AttachmentTarget =
  | { type: 'page'; pageId: string; driveId: string }
  | { type: 'conversation'; conversationId: string };

const UPLOAD_SCOPES: ServiceScope[] = ['files:write'];
const CONVERSATION_TOKEN_EXPIRY_MS = 10 * 60 * 1000; // match createUploadServiceToken default

export interface CreateAttachmentUploadServiceTokenArgs {
  userId: string;
  target: AttachmentTarget;
}

export interface AttachmentUploadServiceToken {
  token: string;
}

/**
 * Mint an upload service token bound to the given attachment target.
 *
 * Page target delegates to {@link createUploadServiceToken} with `parentId === pageId`,
 * preserving the channel-route behavior at apps/web/src/app/api/channels/[pageId]/upload/route.ts:127-144.
 *
 * Conversation target validates participant membership of the DM, then mints a session
 * with `resourceType: 'conversation'` and no driveId — DM files have no drive.
 *
 * @throws PermissionDeniedError if the caller lacks permission for the target.
 */
export async function createAttachmentUploadServiceToken(
  args: CreateAttachmentUploadServiceTokenArgs
): Promise<AttachmentUploadServiceToken> {
  const { userId, target } = args;

  switch (target.type) {
    case 'page': {
      const result = await createUploadServiceToken({
        userId,
        driveId: target.driveId,
        pageId: target.pageId,
        parentId: target.pageId,
      });
      loggers.api.info('Attachment upload token grant', {
        userId,
        targetType: 'page',
        pageId: target.pageId,
        driveId: target.driveId,
        scopes: UPLOAD_SCOPES,
      });
      return { token: result.token };
    }

    case 'conversation': {
      const conversation = await db.query.dmConversations.findFirst({
        where: eq(dmConversations.id, target.conversationId),
        columns: {
          id: true,
          participant1Id: true,
          participant2Id: true,
        },
      });

      if (!conversation) {
        loggers.api.warn('Upload token denied: conversation not found', {
          userId,
          conversationId: target.conversationId,
        });
        throw new PermissionDeniedError('Permission denied');
      }

      const isParticipant =
        conversation.participant1Id === userId || conversation.participant2Id === userId;
      if (!isParticipant) {
        loggers.api.warn('Upload token denied: not a conversation participant', {
          userId,
          conversationId: target.conversationId,
        });
        throw new PermissionDeniedError('Permission denied');
      }

      const token = await sessionService.createSession({
        userId,
        type: 'service',
        scopes: UPLOAD_SCOPES as string[],
        resourceType: 'conversation',
        resourceId: target.conversationId,
        expiresInMs: CONVERSATION_TOKEN_EXPIRY_MS,
        createdByService: 'web',
      });

      loggers.api.info('Attachment upload token grant', {
        userId,
        targetType: 'conversation',
        conversationId: target.conversationId,
        scopes: UPLOAD_SCOPES,
      });

      return { token };
    }

    default: {
      // Exhaustiveness check — the type system should prevent reaching this branch,
      // but a runtime guard protects against unsafe casts at the route boundary.
      const _exhaustive: never = target;
      void _exhaustive;
      throw new Error(
        `Unknown attachment target type: ${(target as { type?: unknown }).type}`
      );
    }
  }
}
