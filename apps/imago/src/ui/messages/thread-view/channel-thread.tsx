'use client';

import { useDriveChannels } from '../use-messages/use-messages';
import { useChannelPostable, useChannelThread } from '../channel-thread/use-channel-thread';
import { threadPosts } from '../thread/thread-state';
import { todayOf } from '../../time/time';
import { renderErrorState } from '../../frame/edge-state/edge-state.render';
import { CHANNEL_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { ThreadObject } from './thread-object';

export type ChannelThreadProps = {
  readonly driveId: string;
  readonly pageId: string;
  /** The signed-in viewer: their posts are never unread, their mentions are marked. */
  readonly viewerId: string;
  /** The clock the day dividers read; injected for tests. */
  readonly now?: () => Date;
  readonly markReadDelayMs?: number;
};

const systemNow = () => new Date();

/**
 * The channel at /imago/[driveId]/messages/[pageId], in the object slot: its
 * posts from /api/channels/[pageId]/messages, marked read once viewed, with a
 * composer that posts optimistically and new posts arriving live — or a
 * view-only notice for a member who may not post. Its name comes from the
 * drive's channel list the messages pane has already loaded.
 */
export function ChannelThread({ driveId, pageId, viewerId, now = systemNow, markReadDelayMs }: ChannelThreadProps) {
  const { channels } = useDriveChannels(driveId);
  const listed = channels?.find((candidate) => candidate.id === pageId);
  const { state, loadOlder, send, retry } = useChannelThread({
    pageId,
    viewerId,
    markReadDelayMs,
    now,
    listed: listed !== undefined,
  });
  const canPost = useChannelPostable(pageId);

  // The drive's channels are the authority on which ids are its channels; a
  // refused or unknown id says the same, so it never tells which it was.
  if ((channels !== undefined && listed === undefined) || state.status === 'not-found') {
    return renderNotFound({
      ...CHANNEL_NOT_FOUND,
      homeHref: `/${encodeURIComponent(driveId)}/messages`,
      linkLabel: 'Back to Messages',
    });
  }
  if (state.status === 'error') return renderErrorState({ title: 'Could not load this channel', retry });

  return (
    <ThreadObject
      kind="channel"
      name={listed?.name ?? 'Channel'}
      viewerId={viewerId}
      state={state}
      posts={threadPosts(state)}
      loadOlder={loadOlder}
      send={send}
      canPost={canPost}
      today={todayOf(now())}
    />
  );
}
