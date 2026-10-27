'use client';

import type { ChannelThread, DirectThread, MessageThread } from '../message-model/message';
import { useDirectThreads, useDriveChannels, useInbox } from '../use-messages/use-messages';
import { InboxPane } from './inbox-pane';
import { useAllDrives } from '../../frame/drives/use-section-scope';
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
  retry: () => void,
  toRow: (row: T) => MessageRowView,
): MessagesSectionView => {
  if (rows !== undefined) return { status: 'ready', rows: rows.map(toRow) };
  return error === undefined ? { status: 'loading' } : { status: 'error', retry };
};

/**
 * The Messages section's list pane. On the index it is the unified inbox (the drive's channels,
 * or every drive's when Messages is switched to All drives, and the viewer's DMs, with previews
 * and times); with a channel or DM open, or on the user-level /dm routes, it is the compact
 * Channels and Direct messages groups on live unread counts.
 */
export function MessagesPane({ driveId, selectedPageId, selectedConversationId }: MessagesPaneProps) {
  const allDrives = useAllDrives('messages', driveId);
  const unified = driveId !== null && selectedPageId === null && selectedConversationId === null;
  return unified ? (
    <InboxPane driveId={allDrives ? null : driveId} />
  ) : (
    <CompactPane
      driveId={driveId}
      allDrives={allDrives}
      selectedPageId={selectedPageId}
      selectedConversationId={selectedConversationId}
    />
  );
}

const isChannel = (thread: MessageThread): thread is ChannelThread => thread.kind === 'channel';

/**
 * The compact groups: the channels (the current drive's, or every drive's from the inbox when
 * Messages is switched to All drives, so the list matches the head's switch), then the viewer's DMs.
 */
function CompactPane({ driveId, allDrives, selectedPageId, selectedConversationId }: MessagesPaneProps & { readonly allDrives: boolean }) {
  const everyDrive = allDrives && driveId !== null;
  const driveChannels = useDriveChannels(everyDrive ? null : driveId);
  const inbox = useInbox(everyDrive);
  const channels = everyDrive
    ? { channels: inbox.threads?.filter(isChannel), error: inbox.error, retry: inbox.retry }
    : driveChannels;
  const direct = useDirectThreads();
  return renderMessagesPane({
    channels:
      driveId === null
        ? { status: 'no-drive' }
        : sectionOf(channels.channels, channels.error, channels.retry, (thread) => channelRow(thread, selectedPageId)),
    direct: sectionOf(direct.threads, direct.error, direct.retry, (thread) => directRow(thread, selectedConversationId)),
  });
}
