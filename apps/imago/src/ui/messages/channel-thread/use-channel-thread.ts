'use client';

// The open channel: the shared thread (thread/use-thread) on the channel's
// routes and realtime room, and whether the viewer may post in it.

import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { useThread } from '../thread/use-thread';
import { channelThread, fetchCanPost } from './channel-api';

export type UseChannelThreadOptions = {
  readonly pageId: string;
  readonly viewerId: string;
  readonly markReadDelayMs?: number;
  /** The clock a sending post is stamped with until apps/web stores it. */
  readonly now?: () => Date;
  /**
   * Whether the drive's channel list names this channel. Until it does (still
   * loading, or the id is not one of the drive's channels), nothing is marked
   * read: an address that names no channel is never viewed.
   */
  readonly listed?: boolean;
};

export const useChannelThread = ({ pageId, ...options }: UseChannelThreadOptions) =>
  useThread(channelThread, { threadId: pageId, ...options });

/**
 * Whether the viewer may post in the channel: undefined until apps/web says.
 * A permission read that fails leaves posting to the channel route to decide,
 * which refuses with its own reason.
 */
export const useChannelPostable = (pageId: string): boolean | undefined => {
  const client = useApiClient();
  const { data, error } = useSWR(['imago:channel-postable', pageId] as const, ([, id]) => fetchCanPost(client, id));
  return error === undefined ? data : true;
};
