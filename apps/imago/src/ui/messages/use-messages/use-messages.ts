'use client';

// What every Messages surface reads: the current drive's channels, the
// viewer's DMs, and the unread state of both, kept live.
//
// Lists load through the imago client and SWR. Realtime's inbox:* events then
// update a loaded list in place, the way classic's useInboxSocket does: a new
// post counts one more unread and moves its thread up, reading a thread clears
// its count. An event about a thread the list has not loaded (or before it has
// loaded at all) refetches the list instead. The unread totals are the
// server's: any inbox event refetches /api/sidebar/badges, debounced so a busy
// channel does not cost a request per post.

import { useEffect, useRef } from 'react';
import useSWR, { type KeyedMutator } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { useSocketEvent } from '@/realtime/realtime-provider';
import type { ChannelThread, DirectThread, MessageThread, SidebarBadges } from '../message-model/message';
import { applyInboxEvent, concerns, inboxEventOf, type ThreadScope } from '../inbox-event/inbox-event';
import { fetchDirectThreads, fetchDriveChannels, messagePaths } from '../messages-api/messages-api';

/** How long a burst of inbox events waits before the totals are refetched (classic's useSidebarBadges). */
export const BADGES_DEBOUNCE_MS = 250;

/** Applies inbox:* events to one loaded list in the SWR cache. */
const useLiveThreads = <T extends MessageThread>(
  data: readonly T[] | undefined,
  mutate: KeyedMutator<readonly T[]>,
  scope: ThreadScope | null,
) => {
  const loaded = useRef(data);
  useEffect(() => {
    loaded.current = data;
  });

  const onEvent = (payload: unknown) => {
    const event = inboxEventOf(payload);
    if (event === null || scope === null || !concerns(event, scope)) return;
    // Writing into an entry that is still loading would discard the load
    // (SWR drops a fetch a mutation overtook): fetch again instead, so the
    // list starts from an answer given after the event.
    if (loaded.current === undefined) {
      void mutate();
      return;
    }
    let refetch = false;
    // The updater runs at once, on the cache as it is now, so a second list
    // sharing this entry sees the first one's write.
    void mutate(
      (rows) => {
        if (rows === undefined) return rows;
        const applied = applyInboxEvent(rows, event, scope);
        refetch = applied.refetch;
        return applied.rows;
      },
      { revalidate: false },
    );
    if (refetch) void mutate();
  };

  useSocketEvent('inbox:channel_updated', onEvent);
  useSocketEvent('inbox:dm_updated', onEvent);
  useSocketEvent('inbox:read_status_changed', onEvent);
};

/** The drive's CHANNEL pages the viewer can see, with unread counts, live. */
export const useDriveChannels = (driveId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(
    driveId === null ? null : (['imago:drive-channels', driveId] as const),
    ([, id]) => fetchDriveChannels(client, id),
  );
  useLiveThreads<ChannelThread>(data, mutate, driveId === null ? null : { kind: 'channel', driveId });
  return { channels: data, error: error as unknown, isLoading };
};

/** The viewer's DM conversations (user-level, not per drive), with unread counts, live. */
export const useDirectThreads = () => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(['imago:direct-threads'] as const, () =>
    fetchDirectThreads(client),
  );
  useLiveThreads<DirectThread>(data, mutate, { kind: 'dm' });
  return { threads: data, error: error as unknown, isLoading };
};

/** The viewer's unread totals from /api/sidebar/badges, refetched on inbox events. */
export const useUnreadBadges = () => {
  const { data, error, isLoading, mutate } = useSWR<SidebarBadges>(messagePaths.badges);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const refresh = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void mutate();
    }, BADGES_DEBOUNCE_MS);
  };

  useSocketEvent('inbox:channel_updated', refresh);
  useSocketEvent('inbox:dm_updated', refresh);
  useSocketEvent('inbox:read_status_changed', refresh);
  useSocketEvent('inbox:thread_updated', refresh);

  return { badges: data, error: error as unknown, isLoading };
};

/** Everything the Messages section reads for a drive. */
export const useMessages = (driveId: string | null) => {
  const channels = useDriveChannels(driveId);
  const direct = useDirectThreads();
  const unread = useUnreadBadges();
  return {
    channels: channels.channels,
    threads: direct.threads,
    badges: unread.badges,
    error: channels.error ?? direct.error ?? unread.error,
    isLoading: channels.isLoading || direct.isLoading || unread.isLoading,
  };
};
