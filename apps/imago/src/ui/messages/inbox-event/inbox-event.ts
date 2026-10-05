// The inbox:* events realtime relays to the viewer, and what each one does to
// a loaded list of channels or DMs.
//
// apps/web broadcasts them to the viewer's notifications room, which realtime
// joins every socket to on connect (broadcastInboxEvent in
// apps/web/src/lib/websocket/socket-utils.ts): channel_updated and dm_updated
// for a new top-level post, read_status_changed when the viewer reads a
// thread, thread_updated for a reply inside a thread. Payloads arrive as
// whatever realtime sent, so they are read field by field before use.

import type { MessageThread } from '../message-model/message';

export const INBOX_OPERATIONS = ['dm_updated', 'channel_updated', 'read_status_changed', 'thread_updated'] as const;

export type InboxOperation = (typeof INBOX_OPERATIONS)[number];

/** The socket event each operation arrives as. */
export const inboxEventName = (operation: InboxOperation) => `inbox:${operation}` as const;

/** The part of apps/web's InboxEventPayload the unread state is built from. */
export type InboxEvent = {
  readonly operation: InboxOperation;
  readonly type: 'dm' | 'channel';
  readonly id: string;
  readonly driveId?: string;
  readonly lastMessageAt?: string;
  readonly lastMessagePreview?: string;
  readonly lastMessageSender?: string;
  /** The server's own count, when it sends one (read_status_changed sends 0). */
  readonly unreadCount?: number;
};

const OPERATIONS: ReadonlySet<string> = new Set(INBOX_OPERATIONS);

const OPTIONAL_STRINGS = ['driveId', 'lastMessageAt', 'lastMessagePreview', 'lastMessageSender'] as const;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The payload as an inbox event, or null when it is not one this layer can use. */
export const inboxEventOf = (payload: unknown): InboxEvent | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  const { operation, type, id, unreadCount } = fields;
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) return null;
  if (type !== 'dm' && type !== 'channel') return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (unreadCount !== undefined && !isCount(unreadCount)) return null;

  const optional: Partial<Record<(typeof OPTIONAL_STRINGS)[number], string>> = {};
  for (const field of OPTIONAL_STRINGS) {
    const value = fields[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    optional[field] = value;
  }

  return {
    operation: operation as InboxOperation,
    type,
    id,
    ...optional,
    ...(unreadCount === undefined ? {} : { unreadCount }),
  };
};

/** What a list holds: the viewer's DMs, or one drive's channels. */
export type ThreadScope = { readonly kind: 'dm' } | { readonly kind: 'channel'; readonly driveId: string };

/** The list after an event; `refetch` when the event names a thread the list has not loaded. */
export type Applied<T> = { readonly rows: readonly T[]; readonly refetch: boolean };

/** Most recent post first; threads never posted in last, in their current order. */
const byLatestPost = <T extends MessageThread>(rows: readonly T[]): readonly T[] =>
  [...rows].sort((a, b) => {
    if (!a.lastMessageAt && !b.lastMessageAt) return 0;
    if (!a.lastMessageAt) return 1;
    if (!b.lastMessageAt) return -1;
    return Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt);
  });

/** Whether the event can change a list of this scope (a thread reply never does). */
export const concerns = (event: InboxEvent, scope: ThreadScope): boolean =>
  event.operation !== 'thread_updated' &&
  event.type === scope.kind &&
  (scope.kind === 'dm' || event.driveId === scope.driveId);

/**
 * A list after an inbox event, as classic's useInboxSocket applies it.
 *
 * A new post shows its preview, counts one more unread (or the server's count
 * when it sent one) and moves its thread to the top. Reading a thread clears
 * its count. A thread reply leaves the top-level count alone, and events for
 * other lists change nothing.
 *
 * The same event can reach one cache entry twice (two mounted lists of the
 * same drive each subscribe), and payloads carry no message id; as in classic,
 * an update whose time and preview already match the row is that same post.
 */
export const applyInboxEvent = <T extends MessageThread>(
  rows: readonly T[],
  event: InboxEvent,
  scope: ThreadScope,
): Applied<T> => {
  const unchanged = { rows, refetch: false };
  if (!concerns(event, scope)) return unchanged;

  const index = rows.findIndex((row) => row.id === event.id);
  if (index === -1) return { rows, refetch: event.operation !== 'read_status_changed' };
  const row = rows[index];

  if (event.operation === 'read_status_changed') {
    const read = { ...row, unreadCount: event.unreadCount ?? 0 };
    return { rows: rows.map((current, i) => (i === index ? read : current)), refetch: false };
  }

  const alreadyApplied =
    event.unreadCount === undefined &&
    event.lastMessageAt !== undefined &&
    event.lastMessageAt === row.lastMessageAt &&
    (!event.lastMessagePreview || event.lastMessagePreview === row.lastMessagePreview);
  if (alreadyApplied) return unchanged;

  const posted: T = {
    ...row,
    lastMessageAt: event.lastMessageAt ?? row.lastMessageAt,
    lastMessagePreview: event.lastMessagePreview || row.lastMessagePreview,
    ...(row.kind === 'channel' ? { lastMessageSender: event.lastMessageSender || row.lastMessageSender } : {}),
    unreadCount: event.unreadCount ?? row.unreadCount + 1,
  };
  return { rows: byLatestPost(rows.map((current, i) => (i === index ? posted : current))), refetch: false };
};
