'use client';

import { useEffect, useRef } from 'react';
import { useDriveChannels } from '../use-messages/use-messages';
import { useChannelThread } from '../channel-thread/use-channel-thread';
import { groupPosts } from '../post-groups/post-groups';
import { todayOf } from '../../time/time';
import { renderThreadView } from './thread-view.render';

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
 * posts from /api/channels/[pageId]/messages, read-only, marked read once
 * viewed. Its name comes from the drive's channel list the messages pane has
 * already loaded.
 */
export function ChannelThread({ driveId, pageId, viewerId, now = systemNow, markReadDelayMs }: ChannelThreadProps) {
  const { channels } = useDriveChannels(driveId);
  const { state, loadOlder } = useChannelThread({ pageId, viewerId, markReadDelayMs });
  const name = channels?.find((channel) => channel.id === pageId)?.name ?? 'Channel';

  // Opening a channel lands where unread begins, else at its newest post;
  // once per open, so loading earlier posts never jumps the view.
  const thread = useRef<HTMLDivElement>(null);
  const placed = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'ready' || placed.current === pageId) return;
    placed.current = pageId;
    const unread = thread.current?.querySelector('[data-new]');
    if (unread) unread.scrollIntoView?.({ block: 'start' });
    else thread.current?.querySelector('ol > li:last-child')?.scrollIntoView?.({ block: 'end' });
  }, [state.status, pageId]);

  return (
    <div ref={thread}>
      {renderThreadView({
        name,
        viewerId,
        status: state.status,
        items: groupPosts(state.posts, { today: todayOf(now()), lastReadAt: state.lastReadAt }),
        older: state.nextCursor === null ? 'none' : state.older,
        loadOlder,
      })}
    </div>
  );
}
