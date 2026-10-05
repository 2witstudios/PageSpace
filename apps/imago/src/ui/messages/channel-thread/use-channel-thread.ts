'use client';

// The open channel: its newest page of posts, older pages on request, and the
// viewer's read mark.
//
// The read watermark the first page carries is where unread began, and it
// stays put for the open: marking the channel read moves the server's, never
// this one. Viewing marks the channel read once per open, a moment after its
// posts are on screen (classic ChannelView's debounce), and only while the
// tab is visible: a background tab waits until it is shown. Leaving first
// marks nothing.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useApiClient } from '@/api/swr-provider';
import { fetchChannelPage, markChannelRead } from './channel-api';
import { initialThreadState, threadReducer, type ThreadState } from './channel-thread-state';

/** How long posts are on screen before the channel counts as read (classic's MARK_READ_DEBOUNCE_MS). */
export const MARK_READ_DEBOUNCE_MS = 1000;

export type UseChannelThreadOptions = {
  readonly pageId: string;
  readonly viewerId: string;
  readonly markReadDelayMs?: number;
};

export const useChannelThread = ({ pageId, viewerId, markReadDelayMs = MARK_READ_DEBOUNCE_MS }: UseChannelThreadOptions) => {
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

  const marked = useRef<string | null>(null);
  const viewed = state.status === 'ready';
  useEffect(() => {
    if (!viewed || marked.current === pageId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (document.visibilityState !== 'visible' || marked.current === pageId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        marked.current = pageId;
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
  }, [client, pageId, viewed, markReadDelayMs]);

  const { status, nextCursor, older } = state;
  const loadOlder = useCallback(() => {
    if (status !== 'ready' || nextCursor === null || older === 'loading') return;
    dispatch({ type: 'olderRequested', pageId });
    fetchChannelPage(client, { pageId, viewerId, cursor: nextCursor }).then(
      (page) => dispatch({ type: 'olderLoaded', pageId, page }),
      () => dispatch({ type: 'olderFailed', pageId }),
    );
  }, [client, pageId, viewerId, status, nextCursor, older]);

  return { state, loadOlder };
};
