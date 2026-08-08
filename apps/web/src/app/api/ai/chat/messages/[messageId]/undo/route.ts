import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage, type AuthResult } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { previewAiUndo, executeAiUndo, type AiUndoPreview } from '@/services/api';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { messageRepository } from '@/lib/repositories/message-repository';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { canAccessConversation, type ConversationAccessRow } from '@pagespace/lib/permissions/conversation-access';

/**
 * The fail-closed stand-in when a message has no conversation row. The
 * predicate is `owner OR (isShared AND page access)`, so an empty owner matches
 * nobody and `isShared: false` stops there — "no row" denies, which is the rule
 * `conversation-access.ts` states for exactly this case.
 */
const NO_CONVERSATION: ConversationAccessRow = { userId: '', isShared: false, type: 'page', contextId: null };

// Request body schema for POST /undo
const undoBodySchema = z.object({
  mode: z.enum(['messages_only', 'messages_and_changes']),
  force: z.boolean().optional().default(false),
});

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * Check undo permissions based on preview source
 * Returns a NextResponse if permission denied, null if allowed
 */
async function checkUndoPermissions(
  request: Request,
  auth: AuthResult,
  userId: string,
  messageId: string,
  preview: AiUndoPreview,
  operationType: 'preview' | 'execution'
): Promise<NextResponse | null> {
  if (preview.source === 'page_chat') {
    // THE CONVERSATION DECIDES FIRST (review finding — MAJOR).
    //
    // This branch used to run `canPrincipalEditPage` and nothing else, while
    // the sweep in `ai-undo-service` is scoped by `conversationId` alone. So
    // any drive member with EDIT on a shared agent page could undo another
    // member's PRIVATE conversation on that page — soft-deleting a range of
    // their messages and rolling back the activities behind them. The GLOBAL
    // branch below always checked ownership, so the weaker gate sat on the
    // shared surface, not the private one.
    //
    // `conversation-access.ts` — added by this same epic — says it outright:
    // "authorizing on 'can this user view the page' would hand one member's
    // private conversation to every other member." That is this, with edit
    // instead of view, on a DESTRUCTIVE verb. Every conversation-scoped READ
    // was routed through the shared predicate; this was the one WRITE left on
    // the old gate.
    //
    // Both gates now apply, and the composition is deliberate: the CONVERSATION
    // decides who may touch this thread (owner, or a shared thread whose page
    // they can see), and the PAGE decides whether they may mutate page state,
    // which undo does when it rolls activities back. Strictly narrower than
    // before — nothing that was allowed and legitimate becomes denied.
    if (!(await canAccessConversation(userId, preview.conversationAccess ?? NO_CONVERSATION))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: { reason: 'conversation_not_accessible', operationType, conversationId: preview.conversationId }, riskScore: 0.6 });
      return NextResponse.json(
        { error: 'You do not have permission to undo messages in this chat' },
        { status: 403 }
      );
    }

    if (!preview.pageId) {
      // A conversation that names no page — `type='drive'`, or a row whose
      // conversation is gone. It reached this branch because `source` is
      // "anything that is not global", and there is no page permission to ask
      // about (review finding — MINOR: this used to be a 500, which reads as a
      // server fault for what is really "this verb does not apply here").
      //
      // 404, not 403: the caller has already passed the conversation gate, so
      // this says nothing about a resource they cannot see, and matches how
      // the page-scoped routes answer a message whose derived page is NULL.
      loggers.api.warn(`Undo ${operationType} on a conversation that names no page`, {
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(preview.conversationId),
      });
      return NextResponse.json(
        { error: 'This conversation does not support undo' },
        { status: 404 }
      );
    }

    // Check MCP page scope
    const scopeError = await checkMCPPageScope(auth, preview.pageId);
    if (scopeError) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: { reason: 'mcp_page_scope_denied', operationType, pageId: preview.pageId }, riskScore: 0.5 });
      return scopeError;
    }

    const canEdit = await canPrincipalEditPage(auth, preview.pageId);
    if (!canEdit) {
      loggers.api.warn(`Undo ${operationType} permission denied`, {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        pageId: maskIdentifier(preview.pageId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: { reason: 'no_edit_permission', operationType, pageId: preview.pageId }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to undo messages in this chat' },
        { status: 403 }
      );
    }
  } else {
    // Global Assistant chat - verify conversation ownership
    const conversation = await globalConversationRepository.getConversationById(userId, preview.conversationId);
    if (!conversation) {
      loggers.api.warn(`Undo ${operationType} permission denied (Global)`, {
        userId: maskIdentifier(userId),
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(preview.conversationId)
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: { reason: 'conversation_not_owned', operationType, conversationId: preview.conversationId }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to undo messages in this chat' },
        { status: 403 }
      );
    }
  }
  return null;
}

/**
 * GET - Preview what will be undone
 * Returns count of messages and activities that will be affected
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_undo', resourceId: 'preview', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { messageId } = await context.params;

    loggers.api.debug('[AiUndo:Route] GET request received', {
      messageId: maskIdentifier(messageId),
      userId: maskIdentifier(userId),
    });

    // Get preview first to determine source and pageId/conversationId
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions
    loggers.api.debug('[AiUndo:Route] Checking permissions', {
      source: preview.source,
      pageId: preview.pageId ? maskIdentifier(preview.pageId) : null,
    });
    const permissionError = await checkUndoPermissions(request, auth, userId, messageId, preview, 'preview');
    if (permissionError) return permissionError;

    loggers.api.debug('[AiUndo:Route] Permission check passed');
    loggers.api.info('Undo preview generated', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      messagesAffected: preview.messagesAffected,
      activitiesAffected: preview.activitiesAffected.length,
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: {
      action: 'undo_preview',
      source: preview.source,
      messagesAffected: preview.messagesAffected,
    } });

    return NextResponse.json(preview);
  } catch (error) {
    loggers.api.error('Error generating undo preview', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Execute undo operation
 * Accepts mode: 'messages_only' | 'messages_and_changes'
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    // Authenticate with CSRF
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_undo', resourceId: 'execute', details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { messageId } = await context.params;
    const body = await request.json();

    loggers.api.debug('[AiUndo:Route] POST request received', {
      messageId: maskIdentifier(messageId),
      userId: maskIdentifier(userId),
    });

    // Validate request body with Zod
    const parseResult = undoBodySchema.safeParse(body);
    if (!parseResult.success) {
      loggers.api.debug('[AiUndo:Route] Invalid request body');
      return NextResponse.json(
        { error: 'Invalid mode. Must be "messages_only" or "messages_and_changes"' },
        { status: 400 }
      );
    }
    const { mode, force } = parseResult.data;

    loggers.api.debug('[AiUndo:Route] Validated mode', { mode });

    // Get preview first to check permissions
    const preview = await previewAiUndo(messageId, userId);

    if (!preview) {
      return NextResponse.json({ error: 'Message not found or preview failed' }, { status: 404 });
    }

    // Check permissions
    const permissionError = await checkUndoPermissions(request, auth, userId, messageId, preview, 'execution');
    if (permissionError) return permissionError;

    loggers.api.debug('[AiUndo:Route] Executing undo', {
      mode,
      messagesAffected: preview.messagesAffected,
      activitiesAffected: preview.activitiesAffected.length,
    });

    // Execute undo, passing preview to avoid redundant computation
    const result = await executeAiUndo(messageId, userId, mode, preview, { force });

    loggers.api.info('Undo executed', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      mode,
      success: result.success,
      messagesDeleted: result.messagesDeleted,
      activitiesRolledBack: result.activitiesRolledBack,
      errorCount: result.errors.length,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          ...result,
          success: false,
          message: 'Undo failed. No changes were applied.',
        },
        { status: 500 }
      );
    }

    // ANNOUNCE the undo. The rev bump already happened, inside the write
    // transaction, via `messageRepository.softDeleteUndoRange` — this route
    // only carries that post-write rev out to the rooms: the legacy
    // chat:undo_applied (moved in from here) plus the authoritative
    // conversation:undo_applied. Page-event broadcasts below cover the
    // page-domain side.
    //
    // The route MUST NOT bump. It used to: `recordUndoApplied` opened its own
    // transaction here, after the write had already committed, inside a
    // swallowing try/catch. A single failure in that block meant a committed
    // deletion with no rev movement and no event — permanent silent staleness
    // in every open pane, because `syncWatchedConversationRevs` compares revs
    // and nothing else, so it could never heal. Emission is still best-effort
    // (it is delivery, not durability); the rev is what makes losing it
    // recoverable.
    if (result.bumpedConversation !== undefined) {
      const legacyTriggeredBy = await resolveTriggeredBy(userId, request);
      const broadcastPageId = preview.source === 'page_chat' && preview.pageId
        ? preview.pageId
        : globalChannelId(userId);
      const messageIdsFromActivities = preview.activitiesAffected
        .filter((a) => a.resourceType === 'message')
        .map((a) => a.resourceId);
      const affectedMessageIds = Array.from(new Set([messageId, ...messageIdsFromActivities]));
      messageRepository.emitUndoApplied({
        conversationId: preview.conversationId,
        bumped: result.bumpedConversation,
        legacyChannelId: broadcastPageId,
        scope: preview.source === 'page_chat' && preview.pageId
          ? { kind: 'page', pageId: preview.pageId }
          : { kind: 'global', ownerId: userId },
        mode,
        affectedMessageIds,
        legacyTriggeredBy,
      });
    }

    // Broadcast real-time updates for affected pages and channels
    if (mode === 'messages_and_changes') {
      const broadcastedPages = new Set<string>();
      const broadcastedChannels = new Set<string>();
      for (const activity of preview.activitiesAffected) {
        if (activity.resourceType === 'page' && activity.pageId && activity.driveId) {
          // Deduplicate broadcasts for same page
          if (!broadcastedPages.has(activity.pageId)) {
            broadcastedPages.add(activity.pageId);
            await broadcastPageEvent(
              createPageEventPayload(activity.driveId, activity.pageId, 'updated', {
                title: activity.resourceTitle ?? undefined,
              })
            );
            await broadcastPageEvent(
              createPageEventPayload(activity.driveId, activity.pageId, 'content-updated', {
                title: activity.resourceTitle ?? undefined,
              })
            );
          }
        } else if (activity.resourceType === 'message' && activity.pageId) {
          const activityMeta = activity.metadata as Record<string, unknown> | null;
          if (activityMeta?.conversationType === 'channel' && !broadcastedChannels.has(activity.pageId)) {
            broadcastedChannels.add(activity.pageId);
            // Broadcast channel update so clients refresh the message list
            if (process.env.INTERNAL_REALTIME_URL) {
              try {
                const requestBody = JSON.stringify({
                  channelId: activity.pageId,
                  event: 'message_deleted',
                  payload: { messageId: activity.resourceId },
                });
                await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
                  method: 'POST',
                  headers: createSignedBroadcastHeaders(requestBody),
                  body: requestBody,
                });
              } catch (error) {
                loggers.api.error('[AiUndo:Route] Failed to broadcast channel update', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      }
      loggers.api.debug('[AiUndo:Route] Broadcasts sent', {
        pageCount: broadcastedPages.size,
        channelCount: broadcastedChannels.size,
      });
    }

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'ai_chat_undo', resourceId: messageId, details: {
      action: 'undo_execute',
      mode,
      messagesDeleted: result.messagesDeleted,
      activitiesRolledBack: result.activitiesRolledBack,
    } });

    return NextResponse.json({
      ...result,
      success: true,
      message: mode === 'messages_only'
        ? `Deleted ${result.messagesDeleted} messages`
        : `Deleted ${result.messagesDeleted} messages and undid ${result.activitiesRolledBack} changes`,
    });
  } catch (error) {
    loggers.api.error('Error executing undo', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
