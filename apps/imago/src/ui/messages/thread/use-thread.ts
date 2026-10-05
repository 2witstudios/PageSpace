'use client';

// The open thread — a channel or a DM: its newest page of posts, older pages
// on request, and the viewer's read mark. What differs between the two is a
// ThreadKind: the routes, the realtime room and event, and how a broadcast is
// read.
//
// The read watermark the first page carries is where unread began, and it
// stays put for the open: marking the thread read moves the server's, never
// this one. Viewing marks the thread read once per open, a moment after its
// posts are on screen (classic ChannelView's debounce), and only while the
// tab is visible: a background tab waits until it is shown. Leaving first
// marks nothing. A thread whose load already marks it read (a DM's GET does)
// is not marked again for the open. A post from someone else that arrives
// live is read the same way once it is on screen, as classic does.
//
// Sending shows the viewer's post at once and POSTs it with a fresh nonce;
// the POST's answer and realtime's echo each carry that nonce back, and
// whichever lands first takes the sending post's place (thread-state). When
// the echo has already shown the post stored, a POST that then fails (its
// answer lost after apps/web committed) still counts as sent: giving the
// text back would invite a duplicate resend.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { useRoom, useSocketEvent, type RoomEvents } from '@/realtime/realtime-provider';
import { edgeOf } from '../../frame/edge-state/edge-state.render';
import type { Post } from '../message-model/post';
import type { ReceivedPost } from '../message-model/received';
import { initialThreadState, pendingId, threadReducer, type ThreadPage, type ThreadState } from './thread-state';

/** How long posts are on screen before the thread counts as read (classic's MARK_READ_DEBOUNCE_MS). */
export const MARK_READ_DEBOUNCE_MS = 1000;

/** Which thread, as which viewer. */
export type ThreadAddress = { readonly threadId: string; readonly viewerId: string };

/** How one kind of thread is read, sent to and kept live, on the routes apps/web already has. */
export type ThreadKind = {
  readonly fetchPage: (client: ApiClient, address: ThreadAddress & { readonly cursor?: string }) => Promise<ThreadPage>;
  readonly send: (
    client: ApiClient,
    post: ThreadAddress & { readonly content: string; readonly clientNonce: string },
  ) => Promise<ReceivedPost>;
  readonly markRead: (client: ApiClient, threadId: string) => Promise<void>;
  /** Loading the newest page already marks the thread read. */
  readonly loadMarksRead: boolean;
  readonly room: RoomEvents;
  /** realtime's event for a new post in the room. */
  readonly event: string;
  /** A broadcast as a post of the open thread, or null when it is not one the thread shows. */
  readonly live: (payload: unknown, address: ThreadAddress) => ReceivedPost | null;
  /** What the viewer is told when a send is refused, ahead of apps/web's reason. */
  readonly sendFailed: string;
};

export type UseThreadOptions = ThreadAddress & {
  readonly markReadDelayMs?: number;
  /**
   * Whether the list that names the thread names this one. Until it does
   * (still loading, or the id is not one of them), the thread is not loaded,
   * its room not joined and nothing marked read: an address that names no
   * thread is never opened. Each caller says; absent means not listed.
   */
  readonly listed?: boolean;
  /** The clock a sending post is stamped with until apps/web stores it. */
  readonly now?: () => Date;
};

/** How a send ended: stored, or refused with what to tell the viewer. */
export type SendResult = { readonly sent: true } | { readonly sent: false; readonly error: string };

const systemNow = () => new Date();

/** A fresh nonce per send: several can start in one millisecond. */
const mintNonce = (): string => crypto.randomUUID();

/**
 * The viewer as their posts in this thread name them, until the server's
 * copy says; "You" when they have not posted in what is loaded.
 */
const viewerAuthor = (posts: readonly Post[], viewerId: string): Pick<Post, 'authorName' | 'authorImage'> => {
  const own = posts.findLast((post) => post.authorKey === viewerId && !post.agent);
  return own ? { authorName: own.authorName, authorImage: own.authorImage } : { authorName: 'You', authorImage: null };
};

export const useThread = (
  kind: ThreadKind,
  { threadId, viewerId, markReadDelayMs = MARK_READ_DEBOUNCE_MS, now = systemNow, listed = false }: UseThreadOptions,
) => {
  const client = useApiClient();
  const [stored, dispatch] = useReducer(threadReducer, threadId, initialThreadState);
  // Until the effect below opens a newly routed thread, show it loading
  // rather than the last thread's posts.
  const state: ThreadState = stored.threadId === threadId ? stored : initialThreadState(threadId);

  // Each Try again is one more attempt: the load below runs again for it.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    if (!listed) return;
    let live = true;
    dispatch({ type: 'opened', threadId });
    kind.fetchPage(client, { threadId, viewerId }).then(
      (page) => {
        if (live) dispatch({ type: 'loaded', threadId, page });
      },
      (error: unknown) => {
        if (live) dispatch({ type: 'failed', threadId, notFound: edgeOf(error) === 'not-found' });
      },
    );
    return () => {
      live = false;
    };
  }, [kind, client, threadId, viewerId, attempt, listed]);

  // Each send in flight, and whether realtime has echoed it stored yet.
  const inFlight = useRef(new Map<string, boolean>());

  useRoom(kind.room, listed ? threadId : null);
  useSocketEvent(kind.event, (payload: unknown) => {
    if (!listed) return;
    const live = kind.live(payload, { threadId, viewerId });
    if (!live) return;
    if (live.mine && live.nonce !== undefined && inFlight.current.has(live.nonce)) inFlight.current.set(live.nonce, true);
    dispatch({ type: 'received', threadId, ...live });
  });

  // What has been read: the open, and each post from others heard since.
  const marked = useRef<string | null>(null);
  const viewed = state.status === 'ready' && listed;
  const seen = `${threadId}#${state.heard}`;
  const loadMarked = kind.loadMarksRead && state.heard === 0;
  useEffect(() => {
    if (!viewed || marked.current === seen) return;
    if (loadMarked) {
      marked.current = seen;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (document.visibilityState !== 'visible' || marked.current === seen) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        marked.current = seen;
        // Not marking read only leaves the count up: nothing to tell the viewer.
        kind.markRead(client, threadId).catch(() => {});
      }, markReadDelayMs);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [kind, client, threadId, seen, viewed, loadMarked, markReadDelayMs]);

  const { status, nextCursor, older } = state;
  const loadOlder = useCallback(() => {
    if (status !== 'ready' || nextCursor === null || older === 'loading') return;
    dispatch({ type: 'olderRequested', threadId });
    kind.fetchPage(client, { threadId, viewerId, cursor: nextCursor }).then(
      (page) => dispatch({ type: 'olderLoaded', threadId, page }),
      () => dispatch({ type: 'olderFailed', threadId }),
    );
  }, [kind, client, threadId, viewerId, status, nextCursor, older]);

  const { posts } = state;
  const send = useCallback(
    async (content: string): Promise<SendResult> => {
      const clientNonce = mintNonce();
      inFlight.current.set(clientNonce, false);
      dispatch({
        type: 'sent',
        threadId,
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
        const stored = await kind.send(client, { threadId, viewerId, content, clientNonce });
        dispatch({ type: 'received', threadId, ...stored });
        return { sent: true };
      } catch (error) {
        dispatch({ type: 'sendFailed', threadId, nonce: clientNonce });
        if (inFlight.current.get(clientNonce) === true) return { sent: true };
        return {
          sent: false,
          error: error instanceof ApiError ? `${kind.sendFailed} ${error.message}` : kind.sendFailed,
        };
      } finally {
        inFlight.current.delete(clientNonce);
      }
    },
    [kind, client, threadId, viewerId, posts, now],
  );

  return { state, loadOlder, send, retry };
};
