/**
 * Socket.IO utilities for broadcasting page tree and drive events
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import type { AttachmentMeta } from '@pagespace/lib/types';
import { maskIdentifier } from '@/lib/logging/mask';

// Use browser-safe logger for all environments
// This prevents Node.js-specific API errors in browser contexts
const loggers = browserLoggers;

export type PageOperation = 'created' | 'updated' | 'moved' | 'deleted' | 'restored' | 'trashed' | 'content-updated';
export type DriveOperation = 'created' | 'updated' | 'deleted';
export type DriveMemberOperation = 'member_added' | 'member_role_changed' | 'member_removed';
export type TaskOperation = 'task_list_created' | 'task_added' | 'task_updated' | 'task_completed' | 'task_deleted' | 'tasks_reordered';
export type CreditsOperation = 'updated';
export type InboxOperation = 'dm_updated' | 'channel_updated' | 'read_status_changed' | 'thread_updated';

// Kick/revocation types - re-export from shared lib (#2158) so the web client
// and the realtime server's kick transport can never drift on shape.
export type { KickReason, KickPayload, KickResult, AccessRevokedPayload } from '@pagespace/lib/realtime/kick-client';

export interface ActivityEventPayload {
  activityId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  userId: string;
  timestamp: string;
}

export interface PageEventPayload {
  driveId: string;
  pageId: string;
  parentId?: string | null;
  operation: PageOperation;
  title?: string;
  type?: string;
  isPrivate?: boolean;
  socketId?: string; // Socket ID of the user who triggered this event (to prevent self-refetch)
}

export interface DriveEventPayload {
  driveId: string;
  operation: DriveOperation;
  name?: string;
  slug?: string;
  /** Discriminates command/workflow broadcasts from drive-level changes. Absent = drive-level. */
  resourceType?: 'command' | 'workflow';
}

export interface DriveMemberEventPayload {
  driveId: string;
  userId: string; // The affected user
  operation: DriveMemberOperation;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
  driveName?: string;
}

export interface TaskEventPayload {
  type: TaskOperation;
  taskId?: string;
  taskListId?: string;
  pageId?: string;
  userId: string;
  data: {
    [key: string]: unknown;
  };
}

/**
 * Live prepaid-credit balance pushed to a user's notifications channel after their
 * balance changes (an AI call settles, a monthly refill lands, or a top-up pack is
 * purchased). Replaces the retired daily-quota `usage:updated` payload — the cutover
 * to metered credits removed the per-day call counters this used to carry.
 *
 * All money fields are whole cents of customer-facing credit value, mirroring
 * `GET /api/credits`. `conversationId`/`pageId` are optional scoping hints set only
 * by the AI-stream emitters so the per-conversation usage monitor can refresh just
 * the relevant view; the funding emitter omits them.
 */
export interface CreditsEventPayload {
  userId: string;
  operation: CreditsOperation;
  billingEnabled: boolean;
  monthly: {
    remaining: number;
    allowance: number;
    periodEnd: string | null;
  };
  topup: {
    remaining: number;
  };
  /** Outstanding overage owed (non-negative). When > 0, `spendable` is negative. */
  debt: number;
  spendable: number;
  reserved: number;
  conversationId?: string;
  pageId?: string;
}

export interface InboxEventPayload {
  operation: InboxOperation;
  type: 'dm' | 'channel';
  id: string;
  driveId?: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessageSender?: string;
  unreadCount?: number;
  attachmentMeta?: AttachmentMeta | null;
  // thread_updated-only fields. Added inline (rather than as a discriminated
  // union) so existing call sites keep compiling — only thread_updated emitters
  // populate these. Recipients are computed at the call site from
  // `listFollowers`; the payload itself does not carry a recipient list.
  rootMessageId?: string;
  lastReplyAt?: string;
  lastReplyPreview?: string;
  lastReplySender?: { id: string; name: string };
}

/**
 * Emitted on the channel/DM room after a thread reply commits so parent-stream
 * viewers can update the parent's reply-count footer without refetching.
 *
 * Channel room: pageId.  DM room: `dm:${conversationId}`.
 */
export interface ThreadReplyCountUpdatedPayload {
  rootId: string;
  replyCount: number;
  lastReplyAt: string;
}

// Presence types - re-export from shared lib
export type { PresenceViewer, PresencePageViewersPayload } from '@pagespace/lib/types';

const realtimeLogger = loggers.realtime.child({ module: 'socket-utils' });

// Safely access environment variables
const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

const verboseRealtimeLogging = getEnvVar('NODE_ENV') !== 'production';

/**
 * Broadcasts a page event to the realtime server
 * @param payload - The event payload to broadcast
 */
export async function broadcastPageEvent(payload: PageEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping page event broadcast', {
      event: 'page',
      channel: `drive:${maskIdentifier(payload.driveId)}`
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `drive:${payload.driveId}`,
      event: `page:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast page event',
      error instanceof Error ? error : undefined,
      {
        event: 'page',
        channel: `drive:${maskIdentifier(payload.driveId)}`
      }
    );
  }
}

/**
 * Broadcasts a drive event to specific users' drive channels.
 *
 * Security: Only users in recipientUserIds receive the event.
 * Migration note: When org layer exists, this can broadcast to
 * org:${orgId}:drives instead of per-user channels.
 *
 * @param payload - The event payload to broadcast
 * @param recipientUserIds - User IDs who should receive this event
 */
export async function broadcastDriveEvent(
  payload: DriveEventPayload,
  recipientUserIds: string[]
): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping drive event broadcast', {
      event: 'drive'
    });
    return;
  }

  if (recipientUserIds.length === 0) {
    realtimeLogger.debug('No recipients for drive event broadcast', {
      driveId: payload.driveId,
      operation: payload.operation
    });
    return;
  }

  try {
    const results = await Promise.allSettled(
      recipientUserIds.map(async (userId) => {
        const requestBody = JSON.stringify({
          channelId: `user:${userId}:drives`,
          event: `drive:${payload.operation}`,
          payload,
        });
        const response = await fetch(`${realtimeUrl}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
          signal: AbortSignal.timeout(5000),
        });
        // fetch only rejects on network error; HTTP 4xx/5xx must be surfaced explicitly.
        if (!response.ok) {
          throw new Error(`Broadcast HTTP ${response.status}`);
        }
        return response;
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      realtimeLogger.warn('Some drive event broadcasts failed', {
        operation: payload.operation,
        driveId: maskIdentifier(payload.driveId),
        failedCount: failures.length,
        totalCount: recipientUserIds.length,
      });
    } else if (verboseRealtimeLogging) {
      realtimeLogger.debug('Drive event broadcasted to users', {
        operation: payload.operation,
        driveId: maskIdentifier(payload.driveId),
        recipientCount: recipientUserIds.length
      });
    }
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast drive event',
      error instanceof Error ? error : undefined,
      {
        event: 'drive',
        operation: payload.operation
      }
    );
  }
}

/**
 * Broadcasts a drive member event to the realtime server
 * Sent to user-specific channel so only affected user receives it
 * @param payload - The event payload to broadcast
 */
export async function broadcastDriveMemberEvent(payload: DriveMemberEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping member event broadcast', {
      event: 'drive_member',
      userId: maskIdentifier(payload.userId)
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `user:${payload.userId}:drives`,
      event: `drive:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Drive member event broadcasted', {
        operation: payload.operation,
        userId: maskIdentifier(payload.userId),
        driveId: maskIdentifier(payload.driveId)
      });
    }
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast drive member event',
      error instanceof Error ? error : undefined,
      {
        event: 'drive_member',
        operation: payload.operation
      }
    );
  }
}

/**
 * Broadcasts a drive member event to a list of recipient users.
 *
 * Mirrors broadcastDriveEvent's fan-out pattern but for member-event payloads.
 * Used by post-login pending acceptance so admins watching a drive's members
 * page see the realtime promotion as the invitee accepts.
 *
 * Internal failures are logged and swallowed — broadcast is best-effort and
 * must NEVER abort the calling operation (login, in particular).
 */
export async function broadcastDriveMemberEventToRecipients(
  payload: DriveMemberEventPayload,
  recipientUserIds: string[]
): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping member event broadcast', {
      event: 'drive_member',
      operation: payload.operation,
    });
    return;
  }

  if (recipientUserIds.length === 0) {
    realtimeLogger.debug('No recipients for drive member event broadcast', {
      driveId: maskIdentifier(payload.driveId),
      operation: payload.operation,
    });
    return;
  }

  try {
    const results = await Promise.allSettled(
      recipientUserIds.map(async (userId) => {
        const requestBody = JSON.stringify({
          channelId: `user:${userId}:drives`,
          event: `drive:${payload.operation}`,
          payload,
        });
        const response = await fetch(`${realtimeUrl}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
          signal: AbortSignal.timeout(5000),
        });
        // fetch only rejects on network error; HTTP 4xx/5xx must be surfaced explicitly.
        if (!response.ok) {
          throw new Error(`Broadcast HTTP ${response.status}`);
        }
        return response;
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      realtimeLogger.warn('Some drive member event broadcasts failed', {
        operation: payload.operation,
        driveId: maskIdentifier(payload.driveId),
        failedCount: failures.length,
        totalCount: recipientUserIds.length,
      });
    } else if (verboseRealtimeLogging) {
      realtimeLogger.debug('Drive member event broadcasted to recipients', {
        operation: payload.operation,
        driveId: maskIdentifier(payload.driveId),
        recipientCount: recipientUserIds.length,
      });
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast drive member event to recipients',
      error instanceof Error ? error : undefined,
      { event: 'drive_member', operation: payload.operation }
    );
  }
}

/**
 * Helper to create a page event payload
 */
export function createPageEventPayload(
  driveId: string,
  pageId: string,
  operation: PageOperation,
  options: {
    parentId?: string | null;
    title?: string;
    type?: string;
    isPrivate?: boolean;
    socketId?: string;
  } = {}
): PageEventPayload {
  return {
    driveId,
    pageId,
    operation,
    ...options,
  };
}

/**
 * Helper to create a drive event payload
 */
export function createDriveEventPayload(
  driveId: string,
  operation: DriveOperation,
  options: {
    name?: string;
    slug?: string;
    resourceType?: DriveEventPayload['resourceType'];
  } = {}
): DriveEventPayload {
  return {
    driveId,
    operation,
    ...options,
  };
}

/**
 * Helper to create a drive member event payload
 */
export function createDriveMemberEventPayload(
  driveId: string,
  userId: string,
  operation: DriveMemberOperation,
  options: {
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    driveName?: string;
  } = {}
): DriveMemberEventPayload {
  return {
    driveId,
    userId,
    operation,
    ...options,
  };
}

/**
 * Broadcasts a task event to the realtime server.
 *
 * Always fans out to the originating user's task channel
 * (`user:${userId}:tasks`) so their other tabs stay in sync. When
 * `payload.pageId` is set, ALSO fans out to the `pageId` room so any
 * collaborator currently viewing that task list (joined via
 * `join_channel`) sees badge / list updates without a manual refresh.
 *
 * @param payload - The task event payload to broadcast
 */
export async function broadcastTaskEvent(payload: TaskEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping task event broadcast', {
      event: 'task'
    });
    return;
  }

  const event = `task:${payload.type}`;
  const channelIds = [`user:${payload.userId}:tasks`];
  if (payload.pageId) {
    channelIds.push(payload.pageId);
  }

  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const requestBody = JSON.stringify({ channelId, event, payload });
        await fetch(`${realtimeUrl}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        // Log error but don't throw - broadcasting failures shouldn't break operations
        realtimeLogger.error(
          'Failed to broadcast task event',
          error instanceof Error ? error : undefined,
          {
            event: 'task',
            channel: channelId.startsWith('user:')
              ? `user:${maskIdentifier(payload.userId)}:tasks`
              : maskIdentifier(channelId),
          }
        );
      }
    })
  );
}

/**
 * Broadcasts a prepaid-credit balance update to the user's notifications channel.
 * Emitted after the balance changes — an AI call settles, a monthly refill lands,
 * or a top-up pack is purchased — so the credit-balance widget updates live without
 * polling. Best-effort: a broadcast failure is logged and swallowed, never thrown.
 * @param payload - The credits event payload to broadcast
 */
export async function broadcastCreditsEvent(payload: CreditsEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping credits event broadcast', {
      event: 'credits'
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `notifications:${payload.userId}`,
      event: `credits:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Credits event broadcasted', {
        userId: maskIdentifier(payload.userId),
        operation: payload.operation,
        spendable: payload.spendable,
      });
    }
  } catch (error) {
    // Log error but don't throw - broadcasting failures shouldn't break operations
    realtimeLogger.error(
      'Failed to broadcast credits event',
      error instanceof Error ? error : undefined,
      {
        event: 'credits',
        channel: `notifications:${maskIdentifier(payload.userId)}`
      }
    );
  }
}

/**
 * Broadcasts an inbox event to a user's notification channel
 * Used for real-time DM/channel updates in the inbox
 * @param userId - The user to notify
 * @param payload - The inbox event payload
 */
export async function broadcastInboxEvent(userId: string, payload: InboxEventPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping inbox event broadcast', {
      event: 'inbox',
      operation: payload.operation,
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: `notifications:${userId}`,
      event: `inbox:${payload.operation}`,
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Inbox event broadcasted', {
        userId: maskIdentifier(userId),
        operation: payload.operation,
        type: payload.type,
        id: maskIdentifier(payload.id),
      });
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast inbox event',
      error instanceof Error ? error : undefined,
      {
        event: 'inbox',
        channel: `notifications:${maskIdentifier(userId)}`,
      }
    );
  }
}

/**
 * Broadcasts thread_reply_count_updated to a channel or DM room so the parent
 * footer (e.g. "3 replies · last reply 2m ago") stays live without a refetch.
 *
 * Failures are logged and swallowed — the originating insert has already
 * committed, and a missed broadcast is recoverable on the next refresh.
 */
export async function broadcastThreadReplyCountUpdated(
  channelId: string,
  payload: ThreadReplyCountUpdatedPayload
): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping thread reply count broadcast', {
      event: 'thread_reply_count_updated',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId,
      event: 'thread_reply_count_updated',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast thread_reply_count_updated',
      error instanceof Error ? error : undefined,
      {
        event: 'thread_reply_count_updated',
        channel: maskIdentifier(channelId),
      }
    );
  }
}

/**
 * Broadcasts a `machine-workspace:*` event to a Machine's page-id room (see
 * apps/realtime's `join_channel`/`getUserAccessLevel` — a Machine's identity
 * IS its backing page id, so this reaches every browser/user currently
 * viewing that Machine). Generic over `event`/`payload` rather than one
 * function per event, unlike most broadcasters in this file, since the four
 * `machine-workspace:*` events (`created`/`updated`/`deleted`/`bootstrapped`)
 * share nothing beyond "something about this machine's workspace list
 * changed" — modeled on `broadcastThreadReplyCountUpdated`'s raw-channelId
 * shape rather than inventing four near-identical wrapper functions.
 *
 * Failures are logged and swallowed — the originating DB write has already
 * committed, and a missed broadcast just means other browsers catch up on
 * their next `GET /api/machines/workspaces` instead of live.
 */
export async function broadcastMachineWorkspaceEvent(
  machineId: string,
  event: string,
  payload: unknown
): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping machine workspace broadcast', { event });
    return;
  }

  try {
    const requestBody = JSON.stringify({ channelId: machineId, event, payload });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error('Failed to broadcast machine workspace event', error instanceof Error ? error : undefined, {
      event,
      channel: maskIdentifier(machineId),
    });
  }
}

// ============================================================================
// AI Stream Events
// ============================================================================

export interface AiStreamStartPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  /**
   * ISO timestamp of the stream's `aiStreamSessions.started_at`, so remote
   * surfaces can stamp synthesized bubbles. Optional for cross-version safety:
   * during a rolling deploy an originator running the previous build emits this
   * event without the field, and consumers degrade to a timestamp-less bubble.
   */
  startedAt?: string;
  /**
   * Whether the stream's conversation is explicitly shared.
   *
   * A page room contains every member of the page, but conversations are PRIVATE by
   * default (`listConversations` shows you only `userId = you OR isShared`). Without
   * this flag every member's client would try to join every stream on the page and be
   * refused — a wasted request and an `authz.access.denied` audit row per member per
   * assistant message, on entirely routine private chat.
   *
   * Optional for the same cross-version reason as `startedAt`: during a rolling deploy
   * an originator on the previous build emits no field, so consumers must treat
   * `undefined` as "unknown, ask the server" and only skip on an explicit `false`.
   * The server remains the authority either way (see stream-subscription-authz.ts).
   */
  isShared?: boolean;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface AiStreamCompletePayload {
  messageId: string;
  pageId: string;
  conversationId?: string;
  aborted?: boolean;
}

export interface ChatUserMessagePayload {
  message: import('ai').UIMessage;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatMessageEditedPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  parts: import('ai').UIMessage['parts'];
  editedAt: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatMessageDeletedPayload {
  messageId: string;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatUndoAppliedPayload {
  conversationId: string;
  pageId: string;
  mode: 'messages_only' | 'messages_and_changes';
  affectedMessageIds: string[];
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatConversationAddedPayload {
  agentId: string;
  conversation: {
    id: string;
    title: string;
    createdAt: string;
  };
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatGlobalConversationAddedPayload {
  conversation: {
    id: string;
    title: string;
    type: string;
    createdAt: string;
  };
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatConversationRenamedPayload {
  agentId: string;
  conversationId: string;
  title: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface ChatConversationDeletedPayload {
  agentId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface AgentGrantChangedPayload {
  agentId: string;
  triggeredBy: { userId: string };
}

export async function broadcastAiStreamStart(payload: AiStreamStartPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping AI stream start broadcast', {
      event: 'ai_stream_start',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:stream_start',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast AI stream start',
      error instanceof Error ? error : undefined,
      {
        event: 'ai_stream_start',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastAiStreamComplete(payload: AiStreamCompletePayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping AI stream complete broadcast', {
      event: 'ai_stream_complete',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:stream_complete',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast AI stream complete',
      error instanceof Error ? error : undefined,
      {
        event: 'ai_stream_complete',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastChatUserMessage(payload: ChatUserMessagePayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat user-message broadcast', {
      event: 'chat:user_message',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:user_message',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat user-message',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:user_message',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastAiMessageEdited(payload: ChatMessageEditedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat message-edited broadcast', {
      event: 'chat:message_edited',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:message_edited',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat message-edited',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:message_edited',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastAiMessageDeleted(payload: ChatMessageDeletedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat message-deleted broadcast', {
      event: 'chat:message_deleted',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:message_deleted',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat message-deleted',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:message_deleted',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastAiUndoApplied(payload: ChatUndoAppliedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat undo-applied broadcast', {
      event: 'chat:undo_applied',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.pageId,
      event: 'chat:undo_applied',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat undo-applied',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:undo_applied',
        channel: maskIdentifier(payload.pageId),
      }
    );
  }
}

export async function broadcastAiConversationAdded(payload: ChatConversationAddedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat conversation-added broadcast', {
      event: 'chat:conversation_added',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.agentId,
      event: 'chat:conversation_added',
      payload,
    });

    await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat conversation-added',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:conversation_added',
        channel: maskIdentifier(payload.agentId),
      }
    );
  }
}

export async function broadcastGlobalConversationAdded(
  channelId: string,
  payload: ChatGlobalConversationAddedPayload,
): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping global conversation-added broadcast', {
      event: 'chat:global_conversation_added',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId,
      event: 'chat:global_conversation_added',
      payload,
    });

    const response = await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Broadcast failed with status ${response.status}`);
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast global conversation-added',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:global_conversation_added',
        channel: maskIdentifier(channelId),
      }
    );
  }
}

export async function broadcastAiConversationRenamed(payload: ChatConversationRenamedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat conversation-renamed broadcast', {
      event: 'chat:conversation_renamed',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.agentId,
      event: 'chat:conversation_renamed',
      payload,
    });

    const response = await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Broadcast HTTP ${response.status}`);
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat conversation-renamed',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:conversation_renamed',
        channel: maskIdentifier(payload.agentId),
      }
    );
  }
}

export async function broadcastAiConversationDeleted(payload: ChatConversationDeletedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping chat conversation-deleted broadcast', {
      event: 'chat:conversation_deleted',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.agentId,
      event: 'chat:conversation_deleted',
      payload,
    });

    const response = await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Broadcast HTTP ${response.status}`);
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast chat conversation-deleted',
      error instanceof Error ? error : undefined,
      {
        event: 'chat:conversation_deleted',
        channel: maskIdentifier(payload.agentId),
      }
    );
  }
}

export async function broadcastAgentGrantChanged(payload: AgentGrantChangedPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping agent grant-changed broadcast', {
      event: 'agent:grant_changed',
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({
      channelId: payload.agentId,
      event: 'agent:grant_changed',
      payload,
    });

    const response = await fetch(`${realtimeUrl}/api/broadcast`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Broadcast HTTP ${response.status}`);
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast agent grant-changed',
      error instanceof Error ? error : undefined,
      {
        event: 'agent:grant_changed',
        channel: maskIdentifier(payload.agentId),
      }
    );
  }
}

// ============================================================================
// Activity Events (with debouncing)
// ============================================================================

// In-memory debounce state per context
const pendingActivityBroadcasts = new Map<string, NodeJS.Timeout>();
const ACTIVITY_DEBOUNCE_MS = 500;

/**
 * Broadcasts an activity event to the realtime server with debouncing.
 * Events are debounced per context (drive or page) to prevent event storms.
 * @param payload - The activity event payload to broadcast
 */
export async function broadcastActivityEvent(payload: ActivityEventPayload): Promise<void> {
  // Only broadcast if realtime URL is configured
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    return;
  }

  // Determine contexts to broadcast to
  const contexts: { channelId: string; key: string }[] = [];
  if (payload.driveId) {
    contexts.push({
      channelId: `activity:drive:${payload.driveId}`,
      key: `drive:${payload.driveId}`,
    });
  }
  if (payload.pageId) {
    contexts.push({
      channelId: `activity:page:${payload.pageId}`,
      key: `page:${payload.pageId}`,
    });
  }

  // Debounce broadcasts per context
  for (const { channelId, key } of contexts) {
    // Clear existing timeout for this context
    const existing = pendingActivityBroadcasts.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      pendingActivityBroadcasts.delete(key);

      try {
        const requestBody = JSON.stringify({
          channelId,
          event: 'activity:logged',
          payload,
        });

        await fetch(`${realtimeUrl}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
          signal: AbortSignal.timeout(5000),
        });

        if (verboseRealtimeLogging) {
          realtimeLogger.debug('Activity event broadcasted', {
            channelId,
            operation: payload.operation,
            resourceType: payload.resourceType,
          });
        }
      } catch (error) {
        // Log error but don't throw - broadcasting failures shouldn't break operations
        realtimeLogger.error(
          'Failed to broadcast activity event',
          error instanceof Error ? error : undefined,
          {
            event: 'activity',
            channel: channelId,
          }
        );
      }
    }, ACTIVITY_DEBOUNCE_MS);

    pendingActivityBroadcasts.set(key, timeout);
  }
}

// ============================================================================
// Terminal Activity Feed (Terminal Epic 1 T1.5, activity visibility)
// ============================================================================

export interface TerminalActivityEventPayload {
  tenantId: string;
  driveId?: string;
  pageId: string;
  command: string;
  output: string;
  exitCode: number;
  agentLabel: string;
}

/**
 * Streams a successful agent bash run into the referenced Terminal's live
 * PTY/output feed, via a dedicated (non-broadcast-room) realtime endpoint —
 * the human viewer's live session is looked up by derived session key, not
 * by Socket.IO room membership. Best-effort: a failure (or nobody watching)
 * must never affect the tool call that already succeeded.
 */
export async function notifyTerminalAgentActivity(payload: TerminalActivityEventPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    return;
  }

  try {
    const requestBody = JSON.stringify(payload);
    await fetch(`${realtimeUrl}/api/terminal-activity`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    realtimeLogger.error(
      'Failed to notify terminal agent activity',
      error instanceof Error ? error : undefined,
      {
        event: 'terminal_activity',
        pageId: maskIdentifier(payload.pageId),
      }
    );
  }
}

// ============================================================================
// Permission Revocation (Kick API)
// ============================================================================
//
// The kick transport itself (kickUserFromRooms) and the revocation→kick hooks
// that call it (kickForPagePermissionRevocation, kickForDriveMembershipRevocation)
// now live in @pagespace/lib (#2158) — permission mutations trigger kicks
// directly at the mutation layer, and the remaining call sites that revoke
// access outside that layer (drive member removal, activity rollback,
// page-goes-private) import the hooks from '@pagespace/lib/permissions/revocation-kick'
// instead of hand-picking rooms here. See that module's doc comment for the
// full rationale (this used to be four per-route kick calls, easy to forget
// on a new revocation path).