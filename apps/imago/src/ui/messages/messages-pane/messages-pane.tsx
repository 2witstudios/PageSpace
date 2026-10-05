'use client';

import type { ChannelThread, DirectThread } from '../message-model/message';
import { useDirectThreads, useDriveChannels } from '../use-messages/use-messages';
import { renderMessagesPane, type MessageRowView, type MessagesSectionView } from './messages-pane.render';

export type MessagesPaneProps = {
  /** The current drive; null on the user-level /dm routes, which have no channels. */
  readonly driveId: string | null;
  /** The channel open as the object, if any. */
  readonly selectedPageId: string | null;
  /** The DM open as the object, if any. */
  readonly selectedConversationId: string | null;
};

const segment = encodeURIComponent;

const channelRow = (thread: ChannelThread, selectedPageId: string | null): MessageRowView => ({
  id: thread.id,
  kind: 'channel',
  name: thread.name,
  href: `/${segment(thread.driveId)}/messages/${segment(thread.id)}`,
  avatarUrl: null,
  unreadCount: thread.unreadCount,
  selected: thread.id === selectedPageId,
});

const directRow = (thread: DirectThread, selectedConversationId: string | null): MessageRowView => ({
  id: thread.id,
  kind: 'dm',
  // The other person's user row can be gone; the row still needs a name.
  name: thread.name || 'Unknown user',
  href: `/dm/${segment(thread.id)}`,
  avatarUrl: thread.avatarUrl,
  unreadCount: thread.unreadCount,
  selected: thread.id === selectedConversationId,
});

const sectionOf = <T,>(
  rows: readonly T[] | undefined,
  error: unknown,
  toRow: (row: T) => MessageRowView,
): MessagesSectionView => {
  if (rows !== undefined) return { status: 'ready', rows: rows.map(toRow) };
  return error === undefined ? { status: 'loading' } : { status: 'error' };
};

/**
 * The Messages section's list pane on IMG-8.1's live data: the current
 * drive's channels and the viewer's DMs with their unread counts, which
 * inbox events keep current.
 */
export function MessagesPane({ driveId, selectedPageId, selectedConversationId }: MessagesPaneProps) {
  const channels = useDriveChannels(driveId);
  const direct = useDirectThreads();
  return renderMessagesPane({
    channels:
      driveId === null
        ? { status: 'no-drive' }
        : sectionOf(channels.channels, channels.error, (thread) => channelRow(thread, selectedPageId)),
    direct: sectionOf(direct.threads, direct.error, (thread) => directRow(thread, selectedConversationId)),
  });
}
