'use client';

import { useMemo } from 'react';
import { useDirectThreads } from '../use-messages/use-messages';
import { useDmThread } from '../dm-thread/use-dm-thread';
import { namedPosts, type DmPerson } from '../message-model/dm-message';
import { threadPosts } from '../thread/thread-state';
import { todayOf } from '../../time/time';
import { renderErrorState } from '../../frame/edge-state/edge-state.render';
import { CONVERSATION_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { ThreadObject } from './thread-object';

export type DmThreadProps = {
  readonly conversationId: string;
  /** The signed-in viewer: their messages are never unread, their mentions are marked. */
  readonly viewerId: string;
  /** The clock the day dividers read; injected for tests. */
  readonly now?: () => Date;
  readonly markReadDelayMs?: number;
};

const systemNow = () => new Date();

/**
 * The DM at /imago/dm/[conversationId], in the object slot, in the same
 * thread view as a channel: its messages from /api/messages/[conversationId],
 * a composer that sends optimistically, and replies arriving live. The other
 * person's name and face come from the DM list the messages pane has already
 * loaded. A conversation apps/web refuses (the viewer is not in it, though
 * the list still names it) draws only not-found: no name, face or messages.
 */
export function DmThread({ conversationId, viewerId, now = systemNow, markReadDelayMs }: DmThreadProps) {
  const { threads } = useDirectThreads();
  const { state, loadOlder, send, retry } = useDmThread({ conversationId, viewerId, markReadDelayMs, now });
  const other = threads?.find((thread) => thread.id === conversationId);

  const people = useMemo((): Readonly<Record<string, DmPerson>> => {
    if (!other?.otherUserId || other.name === '') return {};
    return { [other.otherUserId]: { name: other.name, image: other.avatarUrl } };
  }, [other?.otherUserId, other?.name, other?.avatarUrl]);

  if (state.status === 'not-found')
    return renderNotFound({ ...CONVERSATION_NOT_FOUND, homeHref: '/dm', linkLabel: 'Back to Messages' });
  if (state.status === 'error') return renderErrorState({ title: 'Could not load this conversation', retry });

  return (
    <ThreadObject
      kind="dm"
      name={other?.name || 'Direct message'}
      image={other?.avatarUrl ?? null}
      viewerId={viewerId}
      state={state}
      posts={namedPosts(threadPosts(state), { viewerId, people })}
      loadOlder={loadOlder}
      send={send}
      canPost
      today={todayOf(now())}
    />
  );
}
