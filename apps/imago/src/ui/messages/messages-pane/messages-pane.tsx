'use client';

import type { ChannelThread, DirectThread } from '../message-model/message';
import { useAllChannels, useDirectThreads, useDriveChannels } from '../use-messages/use-messages';
import { useAllDrives } from '../../frame/drives/use-section-scope';
import { useDriveNames } from '../../frame/drives/use-drive-names';
import { channelsByDrive, DIRECT_GROUP, driveGroup } from './message-groups';
import {
  channelNotes,
  directNotes,
  renderMessagesPane,
  type MessageRowView,
  type MessagesGroupView,
  type MessagesSectionView,
} from './messages-pane.render';
import { useCollapsedGroups } from './useCollapsedGroups';

export type MessagesPaneProps = {
  /** The current drive; null on the user-level /dm routes. */
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

type Fold = { readonly collapsed: readonly string[]; readonly toggle: (key: string) => void };

const groupOf = (
  key: string,
  label: string,
  section: MessagesSectionView,
  notes: MessagesGroupView['notes'],
  { collapsed, toggle }: Fold,
): MessagesGroupView => ({ key, label, section, notes, open: !collapsed.includes(key), toggle: () => toggle(key) });

/** One drive's channels, under a Channels label. */
function useDriveGroups(driveId: string, selectedPageId: string | null, fold: Fold): readonly MessagesGroupView[] {
  const { channels, error, retry } = useDriveChannels(driveId);
  const section = sectionOf(channels, error, retry, (thread) => channelRow(thread, selectedPageId));
  return [groupOf(driveGroup(driveId), 'Channels', section, channelNotes, fold)];
}

/**
 * Every drive's channels, one group per drive named for it, from one load
 * (live). Until it answers, or when there are no channels, one Channels group
 * says so.
 */
function useAllDriveGroups(selectedPageId: string | null, fold: Fold): readonly MessagesGroupView[] {
  const { channels, error, retry } = useAllChannels();
  const driveNames = useDriveNames(true);
  const placeholder = (section: MessagesSectionView) => [groupOf('channels', 'Channels', section, channelNotes, fold)];
  if (channels === undefined) return placeholder(error === undefined ? { status: 'loading' } : { status: 'error', retry });
  const drives = channelsByDrive(channels, driveNames ?? new Map());
  if (drives.length === 0) return placeholder({ status: 'ready', rows: [] });
  return drives.map((drive) =>
    groupOf(
      driveGroup(drive.driveId),
      drive.name,
      { status: 'ready', rows: drive.channels.map((thread) => channelRow(thread, selectedPageId)) },
      channelNotes,
      fold,
    ),
  );
}

/**
 * The Messages section's list pane, the same on every Messages route: a
 * drive's channels (every drive's when the head's switch says All drives, as
 * it does by default on Home, and on the user-level /dm routes), then the
 * viewer's DMs. Opening a thread only marks its row; folding a group
 * holds across routes.
 */
export function MessagesPane({ driveId, selectedPageId, selectedConversationId }: MessagesPaneProps) {
  const allDrives = useAllDrives('messages', driveId) || driveId === null;
  return allDrives ? (
    <AllDrivesPane selectedPageId={selectedPageId} selectedConversationId={selectedConversationId} />
  ) : (
    <DrivePane driveId={driveId} selectedPageId={selectedPageId} selectedConversationId={selectedConversationId} />
  );
}

type SelectionProps = Pick<MessagesPaneProps, 'selectedPageId' | 'selectedConversationId'>;

function useDirectGroup(selectedConversationId: string | null, fold: Fold): MessagesGroupView {
  const { threads, error, retry } = useDirectThreads();
  const section = sectionOf(threads, error, retry, (thread) => directRow(thread, selectedConversationId));
  return groupOf(DIRECT_GROUP, 'Direct messages', section, directNotes, fold);
}

function DrivePane({ driveId, selectedPageId, selectedConversationId }: SelectionProps & { readonly driveId: string }) {
  const [collapsed, toggle] = useCollapsedGroups();
  const fold = { collapsed, toggle };
  const channels = useDriveGroups(driveId, selectedPageId, fold);
  const direct = useDirectGroup(selectedConversationId, fold);
  return renderMessagesPane({ groups: [...channels, direct] });
}

function AllDrivesPane({ selectedPageId, selectedConversationId }: SelectionProps) {
  const [collapsed, toggle] = useCollapsedGroups();
  const fold = { collapsed, toggle };
  const channels = useAllDriveGroups(selectedPageId, fold);
  const direct = useDirectGroup(selectedConversationId, fold);
  return renderMessagesPane({ groups: [...channels, direct] });
}
