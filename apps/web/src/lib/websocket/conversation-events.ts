/**
 * Authoritative conversation events (Agent-Session Single Source of Truth
 * epic, Phase 2; spec docs/2.0-architecture/agent-sessions.md §3).
 *
 * Every durable message/conversation write emits one of these events, from
 * the repository choke points (message-repository.ts,
 * conversation-repository.ts, global-conversation-repository.ts) — NEVER
 * from a route. Routes no longer decide whether to broadcast; room
 * membership is the authorization (join_conversation authorizes with
 * `canAccessConversation`).
 *
 * Two planes:
 *
 *   CONTENT — emitted to the conversation's own room, `conv:<id>`
 *   (`conversationRoom`), unconditionally:
 *     - `conversation:message_created`  full message when its serialized
 *        UIMessage is ≤ MAX_INLINE_MESSAGE_BYTES, else an id-level
 *        `messageRef` + `truncated: true` (the client refetches);
 *     - `conversation:message_updated`  same shape;
 *     - `conversation:message_deleted`  id-level;
 *     - `conversation:undo_applied`.
 *
 *   DIRECTORY — emitted to the owner's `user:<ownerId>:sessions` room
 *   (`userSessionsRoom`), PLUS the page room when the conversation is
 *   explicitly shared (page-room members already receive per-conversation
 *   chat events for shared conversations, so this widens nothing):
 *     - `conversation:created/updated/closed/reopened/deleted` (id-level
 *        payloads + changed fields). Every message write also emits a tiny
 *        `conversation:updated {lastMessageAt, rev}` so lists can bump
 *        without joining conv rooms.
 *
 * AUDIENCE INVARIANT (tested — see __tests__/conversation-events-audience):
 * no event here reaches a wider audience than the pre-change behavior except
 * the owner's own devices. `conv:<id>` membership is owner + (when shared)
 * page-authorized collaborators; `user:<ownerId>:sessions` is the owner's
 * own sockets; the page room is targeted ONLY when `isShared`.
 *
 * Transport: the same signed `POST /api/broadcast` HMAC POST socket-utils.ts
 * uses. Best-effort by design — no retry, failures logged and swallowed;
 * correctness comes from the rev watermark + refetch, not delivery.
 */

import type { UIMessage } from 'ai';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { CONVERSATION_EVENTS } from '@pagespace/lib/realtime/conversation-event-names';
import { conversationRoom, userSessionsRoom, pageRoom } from '@pagespace/lib/realtime/rooms';
import { maskIdentifier } from '@/lib/logging/mask';

const eventsLogger = browserLoggers.realtime.child({ module: 'conversation-events' });

/**
 * Full-message inline cap: a serialized UIMessage at or under this rides the
 * event; over it, the event degrades to an id-level `messageRef` +
 * `truncated: true` and the client refetches. Keeps a pathological
 * multi-megabyte reply from amplifying through every subscriber's socket.
 */
export const MAX_INLINE_MESSAGE_BYTES = 32 * 1024;

/**
 * Where the conversation lives — decides the page room for shared fan-out
 * and tells subscribers which cache to touch without a lookup.
 */
export type ConversationEventScope =
  | { kind: 'page'; pageId: string }
  | { kind: 'global'; ownerId: string };

/**
 * The actor. `browserSessionId` lets the actor's own originating pane skip
 * its self-echo; `'server'` marks a server-side write (worker dispatch,
 * workflow, sweep) that no pane originated.
 */
export interface ConversationEventTriggeredBy {
  userId: string;
  browserSessionId: string;
}

/** Fields common to every conversation event. */
export interface ConversationEventBase {
  conversationId: string;
  /**
   * The post-write `conversations.rev`. 0 when the conversation has no row
   * (legacy page conversations) — subscribers treat that as "no watermark,
   * refetch on doubt".
   */
  rev: number;
  scope: ConversationEventScope;
  /** The agent workspace (`agent_workspaces.id`) the conversation is bound into, or null. */
  workspaceId: string | null;
  triggeredBy: ConversationEventTriggeredBy;
}

/** Id-level stand-in for a message too large to inline. */
export interface ConversationMessageRef {
  id: string;
  role: string;
  status: string;
  /**
   * ABSENT when the message carries no timestamp — never "now" (review
   * finding). `createdAt` is the key clients order on, so a fabricated one is
   * the single value guaranteed to be wrong for the messages that reach this
   * shape: a backfill or a replay lands at the bottom of the transcript rather
   * than where it belongs. Missing is a fact a reader can act on; a plausible
   * wrong answer is not.
   */
  createdAt?: string;
}

export type ConversationMessagePayload = ConversationEventBase &
  (
    | { message: UIMessage; truncated?: undefined }
    | { messageRef: ConversationMessageRef; truncated: true }
  );

export interface ConversationMessageDeletedPayload extends ConversationEventBase {
  messageId: string;
}

export interface ConversationUndoAppliedPayload extends ConversationEventBase {
  mode: 'messages_only' | 'messages_and_changes';
  affectedMessageIds: string[];
}

/** Changed-field bag for directory `conversation:updated` events. */
export interface ConversationChangedFields {
  title?: string | null;
  lastMessageAt?: string | null;
  isShared?: boolean;
  workspaceId?: string | null;
  closedInWorkspaceAt?: string | null;
  /**
   * The bound plan page, or null when unbound. On the wire because `PlanChip`
   * renders it: without a field here (and the matching rev bump) a second pane
   * on the same conversation sees an unchanged rev, which it cannot tell apart
   * from "nothing happened", and shows no chip — or a stale one after
   * `clear_plan` — until a reload.
   */
  planPageId?: string | null;
}

export interface ConversationDirectoryPayload extends ConversationEventBase {
  changes?: ConversationChangedFields;
  /** Present on `conversation:created` so sidebars can insert without a fetch. */
  conversation?: {
    id: string;
    title: string | null;
    type: string;
    contextId: string | null;
    workspaceId: string | null;
    isShared: boolean;
    createdAt: string;
    lastMessageAt: string | null;
  };
}

/**
 * The facts the emitters need about the conversation row, as returned by the
 * repositories' in-transaction rev bump.
 */
export interface ConversationEmitContext {
  conversationId: string;
  rev: number;
  scope: ConversationEventScope;
  workspaceId: string | null;
  /** The conversation's OWNER (`conversations.userId`) — the directory-room target. */
  ownerId: string;
  isShared: boolean;
  triggeredBy: ConversationEventTriggeredBy;
}

/** The actor stamp for server-originated writes (no originating pane to self-echo-skip). */
export const SERVER_TRIGGERED_BROWSER_SESSION = 'server';

const getRealtimeUrl = (): string =>
  isNodeEnvironment() ? process.env.INTERNAL_REALTIME_URL || '' : '';

/**
 * The one transport call — mirrors socket-utils.ts's signed POST exactly.
 * Best-effort: every failure logs and swallows; emission must never fail the
 * committed write that triggered it.
 */
async function postBroadcast(channelId: string, event: string, payload: unknown): Promise<void> {
  const realtimeUrl = getRealtimeUrl();
  if (!realtimeUrl) {
    eventsLogger.warn('Realtime URL not configured, skipping conversation event broadcast', {
      event,
    });
    return;
  }

  try {
    const requestBody = JSON.stringify({ channelId, event, payload });
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
    eventsLogger.error(
      'Failed to broadcast conversation event',
      error instanceof Error ? error : undefined,
      { event, channel: maskIdentifier(channelId) },
    );
  }
}

const baseFromContext = (ctx: ConversationEmitContext): ConversationEventBase => ({
  conversationId: ctx.conversationId,
  rev: ctx.rev,
  scope: ctx.scope,
  workspaceId: ctx.workspaceId,
  triggeredBy: ctx.triggeredBy,
});

/**
 * PURE audience computation for the directory plane — exported so the
 * audience-invariant test can enumerate it without IO. Content-plane events
 * always target exactly `[conversationRoom(id)]`.
 */
export const directoryRoomsFor = (ctx: {
  ownerId: string;
  isShared: boolean;
  scope: ConversationEventScope;
}): string[] => {
  const rooms = [userSessionsRoom(ctx.ownerId)];
  if (ctx.isShared && ctx.scope.kind === 'page') {
    rooms.push(pageRoom(ctx.scope.pageId));
  }
  return rooms;
};

/** Content-plane audience — exported for the same test. */
export const contentRoomsFor = (conversationId: string): string[] => [
  conversationRoom(conversationId),
];

/**
 * Shape the message half of a `message_created`/`message_updated` payload:
 * inline when small enough, id-ref + truncated otherwise.
 */
export const shapeMessageForEvent = (
  message: UIMessage & { status?: string; createdAt?: Date | string },
):
  | { message: UIMessage; truncated?: undefined }
  | { messageRef: ConversationMessageRef; truncated: true } => {
  let serializedLength = Infinity;
  try {
    serializedLength = Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    // Unserializable content degrades to the ref shape below.
  }
  if (serializedLength <= MAX_INLINE_MESSAGE_BYTES) {
    return { message };
  }
  // Reported only when the message HAS one. The old fallback to `new Date()`
  // read as a tidy default and was the one answer certain to be wrong: this
  // shape is reached by oversized messages, which is exactly where a backfill
  // or a replay shows up, and `createdAt` is what the client orders on.
  const createdAt = message.createdAt instanceof Date
    ? message.createdAt.toISOString()
    : typeof message.createdAt === 'string'
      ? message.createdAt
      : undefined;
  return {
    messageRef: {
      id: message.id,
      role: message.role,
      status: typeof message.status === 'string' ? message.status : 'complete',
      ...(createdAt === undefined ? {} : { createdAt }),
    },
    truncated: true,
  };
};

type MessageEventName =
  | typeof CONVERSATION_EVENTS.messageCreated
  | typeof CONVERSATION_EVENTS.messageUpdated;

async function emitMessageEvent(
  event: MessageEventName,
  ctx: ConversationEmitContext,
  message: UIMessage & { status?: string; createdAt?: Date | string },
): Promise<void> {
  const payload: ConversationMessagePayload = {
    ...baseFromContext(ctx),
    ...shapeMessageForEvent(message),
  };
  await Promise.all(contentRoomsFor(ctx.conversationId).map((room) => postBroadcast(room, event, payload)));
}

/**
 * Tiny directory bump every message write also emits so lists re-sort
 * without joining conv rooms.
 */
async function emitDirectoryBump(ctx: ConversationEmitContext, lastMessageAt: Date | null): Promise<void> {
  const payload: ConversationDirectoryPayload = {
    ...baseFromContext(ctx),
    changes: { lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null },
  };
  await Promise.all(
    directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.updated, payload)),
  );
}

/**
 * `skipDirectory`: set by the repository when the conversation has NO row
 * (legacy page conversations) — the owner is unknown, so there is no
 * directory room to target; the content-plane event still goes out.
 */
export interface ContentEmitOptions {
  skipDirectory?: boolean;
}

export const conversationEvents = {
  /** A durable message row came into existence (user send, worker dispatch, streaming placeholder). */
  async messageCreated(
    ctx: ConversationEmitContext,
    message: UIMessage & { status?: string; createdAt?: Date | string },
    lastMessageAt: Date | null,
    options: ContentEmitOptions = {},
  ): Promise<void> {
    await emitMessageEvent(CONVERSATION_EVENTS.messageCreated, ctx, message);
    if (!options.skipDirectory) await emitDirectoryBump(ctx, lastMessageAt);
  },

  /** An existing row's content changed (terminal stream write, edit, ask_user merge, materializer). */
  async messageUpdated(
    ctx: ConversationEmitContext,
    message: UIMessage & { status?: string; createdAt?: Date | string },
    lastMessageAt: Date | null,
    options: ContentEmitOptions = {},
  ): Promise<void> {
    await emitMessageEvent(CONVERSATION_EVENTS.messageUpdated, ctx, message);
    if (!options.skipDirectory) await emitDirectoryBump(ctx, lastMessageAt);
  },

  /**
   * A row was tombstoned. `lastMessageAt` is the conversation's RECOMPUTED sort
   * key — the newest message that survived the delete, or null if none did.
   *
   * It used to be hard-coded `null` here, which the directory listener passes
   * straight to `touchConversationInCache`, where null sorts as -Infinity. So
   * deleting a single message dropped a busy conversation to the bottom of the
   * sidebar until something else revalidated it. `messageUpdated` above always
   * carried the real value; these two were the outliers.
   */
  async messageDeleted(
    ctx: ConversationEmitContext,
    messageId: string,
    lastMessageAt: Date | null,
    options: ContentEmitOptions = {},
  ): Promise<void> {
    const payload: ConversationMessageDeletedPayload = { ...baseFromContext(ctx), messageId };
    await Promise.all(
      contentRoomsFor(ctx.conversationId).map((room) =>
        postBroadcast(room, CONVERSATION_EVENTS.messageDeleted, payload),
      ),
    );
    if (!options.skipDirectory) await emitDirectoryBump(ctx, lastMessageAt);
  },

  /** As `messageDeleted`, for a whole undone range. Same recomputed sort key. */
  async undoApplied(
    ctx: ConversationEmitContext,
    details: { mode: 'messages_only' | 'messages_and_changes'; affectedMessageIds: string[] },
    lastMessageAt: Date | null,
    options: ContentEmitOptions = {},
  ): Promise<void> {
    const payload: ConversationUndoAppliedPayload = { ...baseFromContext(ctx), ...details };
    await Promise.all(
      contentRoomsFor(ctx.conversationId).map((room) =>
        postBroadcast(room, CONVERSATION_EVENTS.undoApplied, payload),
      ),
    );
    if (!options.skipDirectory) await emitDirectoryBump(ctx, lastMessageAt);
  },

  /** Directory: a conversation row was created (includes server-spawned workers). */
  async created(
    ctx: ConversationEmitContext,
    conversation: NonNullable<ConversationDirectoryPayload['conversation']>,
  ): Promise<void> {
    const payload: ConversationDirectoryPayload = { ...baseFromContext(ctx), conversation };
    await Promise.all(
      directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.created, payload)),
    );
  },

  /** Directory: metadata changed (title, isShared, workspaceId claim, ...). */
  async updated(ctx: ConversationEmitContext, changes: ConversationChangedFields): Promise<void> {
    const payload: ConversationDirectoryPayload = { ...baseFromContext(ctx), changes };
    await Promise.all(
      directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.updated, payload)),
    );
  },

  async closed(ctx: ConversationEmitContext): Promise<void> {
    const payload: ConversationDirectoryPayload = { ...baseFromContext(ctx) };
    await Promise.all(
      directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.closed, payload)),
    );
  },

  async reopened(ctx: ConversationEmitContext): Promise<void> {
    const payload: ConversationDirectoryPayload = { ...baseFromContext(ctx) };
    await Promise.all(
      directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.reopened, payload)),
    );
  },

  async deleted(ctx: ConversationEmitContext): Promise<void> {
    const payload: ConversationDirectoryPayload = { ...baseFromContext(ctx) };
    await Promise.all(
      directoryRoomsFor(ctx).map((room) => postBroadcast(room, CONVERSATION_EVENTS.deleted, payload)),
    );
  },

  /**
   * Transitional mirror of the legacy stream lifecycle events into the conv
   * room (stream-lifecycle.ts keeps its page-room emission during the
   * client migration window; the page-room leg dies with the legacy events
   * in a later PR).
   */
  async streamLifecycleMirror(
    conversationId: string,
    event: 'chat:stream_start' | 'chat:stream_complete',
    payload: unknown,
  ): Promise<void> {
    await postBroadcast(conversationRoom(conversationId), event, payload);
  },
};
