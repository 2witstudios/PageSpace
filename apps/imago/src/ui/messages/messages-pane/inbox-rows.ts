import type { MessageThread } from '../message-model/message';

/** The unified inbox's Show filter: every thread, only channels, or only direct messages. */
export type InboxFilter = 'all' | 'channels' | 'direct';

const segment = encodeURIComponent;

const DAY_MS = 86_400_000;

/** Whether a thread of the unified inbox is shown under this filter. */
export const inboxKeeps = (filter: InboxFilter, thread: MessageThread): boolean => {
  if (filter === 'all') return true;
  return filter === 'channels' ? thread.kind === 'channel' : thread.kind === 'dm';
};

/**
 * A thread's time in the inbox: the clock time today, "Yesterday", the weekday within the
 * last week, then the date. Empty for a thread never posted in.
 */
export const inboxWhen = (iso: string | null, now: Date): string => {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return at.toLocaleDateString([], { weekday: 'short' });
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** One row of the unified inbox, ready to draw. */
export type InboxRowView = {
  readonly id: string;
  readonly kind: 'channel' | 'dm';
  readonly name: string;
  /** basePath-relative: Link adds /imago. */
  readonly href: string;
  readonly avatarUrl: string | null;
  readonly unreadCount: number;
  /** "Sender: preview" for a channel, the preview alone for a DM, or the empty-thread line. */
  readonly preview: string;
  readonly when: string;
};

/** A channel's last post reads "Sender: preview"; a DM's, which the server sends without a sender, the preview alone. */
const previewOf = (thread: MessageThread): string => {
  if (thread.lastMessagePreview === null || thread.lastMessagePreview === '') return 'No messages yet';
  if (thread.kind === 'channel' && thread.lastMessageSender) return `${thread.lastMessageSender}: ${thread.lastMessagePreview}`;
  return thread.lastMessagePreview;
};

export const inboxRowOf = (thread: MessageThread, now: Date): InboxRowView =>
  thread.kind === 'channel'
    ? {
        id: thread.id,
        kind: 'channel',
        name: thread.name,
        href: `/${segment(thread.driveId)}/messages/${segment(thread.id)}`,
        avatarUrl: null,
        unreadCount: thread.unreadCount,
        preview: previewOf(thread),
        when: inboxWhen(thread.lastMessageAt, now),
      }
    : {
        id: thread.id,
        kind: 'dm',
        // The other person's user row can be gone; the row still needs a name.
        name: thread.name || 'Unknown user',
        href: `/dm/${segment(thread.id)}`,
        avatarUrl: thread.avatarUrl,
        unreadCount: thread.unreadCount,
        preview: previewOf(thread),
        when: inboxWhen(thread.lastMessageAt, now),
      };
