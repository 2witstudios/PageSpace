'use client';

import { useEffect, useRef, useState } from 'react';
import { useDriveChannels } from '../use-messages/use-messages';
import { useChannelThread } from '../channel-thread/use-channel-thread';
import { threadPosts } from '../channel-thread/channel-thread-state';
import { groupPosts } from '../post-groups/post-groups';
import { todayOf } from '../../time/time';
import { renderErrorState } from '../../frame/edge-state/edge-state.render';
import { CHANNEL_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
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

/** Each channel's unsent text and last send error, for as long as the thread is mounted. */
type Drafts = Readonly<Record<string, { readonly draft: string; readonly error: string | null }>>;

const blank = { draft: '', error: null };

/**
 * The channel at /imago/[driveId]/messages/[pageId], in the object slot: its
 * posts from /api/channels/[pageId]/messages, marked read once viewed, with a
 * composer that posts optimistically and new posts arriving live. Its name
 * comes from the drive's channel list the messages pane has already loaded.
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
  const name = listed?.name ?? 'Channel';

  const [drafts, setDrafts] = useState<Drafts>({});
  const { draft, error } = drafts[pageId] ?? blank;
  const keep = (channel: string, next: { readonly draft: string; readonly error: string | null }) =>
    setDrafts((all) => ({ ...all, [channel]: next }));

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

  // The viewer's own post goes on screen at the foot of the thread.
  const sending = state.sending.length;
  useEffect(() => {
    if (sending > 0) thread.current?.querySelector('ol > li:last-child')?.scrollIntoView?.({ block: 'end' });
  }, [sending]);

  const sendDraft = () => {
    const channel = pageId;
    const content = draft;
    keep(channel, blank);
    void send(content).then((result) => {
      // Not sent: the text comes back, unless the viewer has typed anew.
      if (!result.sent)
        setDrafts((all) => {
          const current = all[channel] ?? blank;
          return { ...all, [channel]: { draft: current.draft === '' ? content : current.draft, error: result.error } };
        });
    });
  };

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
    <div ref={thread}>
      {renderThreadView({
        name,
        viewerId,
        status: state.status,
        items: groupPosts(threadPosts(state), { today: todayOf(now()), lastReadAt: state.lastReadAt }),
        older: state.nextCursor === null ? 'none' : state.older,
        loadOlder,
        composer: {
          draft,
          error,
          typeDraft: (next) => keep(pageId, { draft: next, error }),
          send: sendDraft,
        },
      })}
    </div>
  );
}
