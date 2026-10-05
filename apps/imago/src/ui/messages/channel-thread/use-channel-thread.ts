'use client';

// The open channel: its newest page of posts, older pages on request, and the
// viewer's read mark.
//
// The read watermark the first page carries is where unread began, and it
// stays put for the open: marking the channel read moves the server's, never
// this one. Viewing marks the channel read once per open, a moment after its
// posts are on screen (classic ChannelView's debounce), and only while the
// tab is visible: a background tab waits until it is shown. Leaving first
// marks nothing. A post from someone else that arrives live is read the same
// way once it is on screen, as classic does.
//
// Sending shows the viewer's post at once and POSTs it with a fresh nonce;
// the POST's answer and realtime's echo each carry that nonce back, and
// whichever lands first takes the sending post's place (channel-thread-state).
// Posts from others arrive through the channel's realtime room.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { useChannelRoom, useSocketEvent } from '@/realtime/realtime-provider';
import type { Post } from '../message-model/post';
import { liveChannelPost } from '../message-model/received';
import { fetchChannelPage, markChannelRead, sendChannelPost } from './channel-api';
import { initialThreadState, pendingId, threadReducer, type ThreadState } from './channel-thread-state';

/** How long posts are on screen before the channel counts as read (classic's MARK_READ_DEBOUNCE_MS). */
export const MARK_READ_DEBOUNCE_MS = 1000;

/** realtime's event for a channel post (apps/web's channel messages route broadcasts it). */
export const NEW_MESSAGE = 'new_message';

export type UseChannelThreadOptions = {
  readonly pageId: string;
  readonly viewerId: string;
  readonly markReadDelayMs?: number;
  /** The clock a sending post is stamped with until apps/web stores it. */
  readonly now?: () => Date;
};

/** How a send ended: stored, or refused with what to tell the viewer. */
export type SendResult = { readonly sent: true } | { readonly sent: false; readonly error: string };

const systemNow = () => new Date();

/** A fresh nonce per send: several can start in one millisecond. */
const mintNonce = (): string => crypto.randomUUID();

const SEND_FAILED = 'Could not send your post.';

/**
 * The viewer as their posts in this channel name them, until the server's
 * copy says; "You" when they have not posted in what is loaded.
 */
const viewerAuthor = (posts: readonly Post[], viewerId: string): Pick<Post, 'authorName' | 'authorImage'> => {
  const own = posts.findLast((post) => post.authorKey === viewerId && !post.agent);
  return own ? { authorName: own.authorName, authorImage: own.authorImage } : { authorName: 'You', authorImage: null };
};

export const useChannelThread = ({
  pageId,
  viewerId,
  markReadDelayMs = MARK_READ_DEBOUNCE_MS,
  now = systemNow,
}: UseChannelThreadOptions) => {
  const client = useApiClient();
  const [stored, dispatch] = useReducer(threadReducer, pageId, initialThreadState);
  // Until the effect below opens a newly routed channel, show it loading
  // rather than the last channel's posts.
  const state: ThreadState = stored.pageId === pageId ? stored : initialThreadState(pageId);

  useEffect(() => {
    let live = true;
    dispatch({ type: 'opened', pageId });
    fetchChannelPage(client, { pageId, viewerId }).then(
      (page) => {
        if (live) dispatch({ type: 'loaded', pageId, page });
      },
      () => {
        if (live) dispatch({ type: 'failed', pageId });
      },
    );
    return () => {
      live = false;
    };
  }, [client, pageId, viewerId]);

  useChannelRoom(pageId);
  useSocketEvent(NEW_MESSAGE, (payload: unknown) => {
    const live = liveChannelPost(payload, { pageId, viewerId });
    if (live) dispatch({ type: 'received', pageId, ...live });
  });

  // What has been read: the open, and each post from others heard since.
  const marked = useRef<string | null>(null);
  const viewed = state.status === 'ready';
  const seen = `${pageId}#${state.heard}`;
  useEffect(() => {
    if (!viewed || marked.current === seen) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (document.visibilityState !== 'visible' || marked.current === seen) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        marked.current = seen;
        // Not marking read only leaves the count up: nothing to tell the viewer.
        markChannelRead(client, pageId).catch(() => {});
      }, markReadDelayMs);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [client, pageId, seen, viewed, markReadDelayMs]);

  const { status, nextCursor, older } = state;
  const loadOlder = useCallback(() => {
    if (status !== 'ready' || nextCursor === null || older === 'loading') return;
    dispatch({ type: 'olderRequested', pageId });
    fetchChannelPage(client, { pageId, viewerId, cursor: nextCursor }).then(
      (page) => dispatch({ type: 'olderLoaded', pageId, page }),
      () => dispatch({ type: 'olderFailed', pageId }),
    );
  }, [client, pageId, viewerId, status, nextCursor, older]);

  const { posts } = state;
  const send = useCallback(
    async (content: string): Promise<SendResult> => {
      const clientNonce = mintNonce();
      dispatch({
        type: 'sent',
        pageId,
        post: {
          id: pendingId(clientNonce),
          authorKey: viewerId,
          ...viewerAuthor(posts, viewerId),
          agent: false,
          countsAsUnread: false,
          at: now().toISOString(),
          text: content,
          edited: false,
          reactions: [],
          pending: true,
        },
      });
      try {
        const stored = await sendChannelPost(client, { pageId, viewerId, content, clientNonce });
        dispatch({ type: 'received', pageId, ...stored });
        return { sent: true };
      } catch (error) {
        dispatch({ type: 'sendFailed', pageId, nonce: clientNonce });
        return { sent: false, error: error instanceof ApiError ? `${SEND_FAILED} ${error.message}` : SEND_FAILED };
      }
    },
    [client, pageId, viewerId, posts, now],
  );

  return { state, loadOlder, send };
};
