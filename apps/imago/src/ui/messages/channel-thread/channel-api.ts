// A channel's posts and its read mark, through imago's API client, on the
// routes apps/web already has. Access is decided there.

import type { ApiClient } from '@/api/client';
import type { ChannelMessagesResponse } from '../message-model/post';
import { postsFrom } from '../message-model/posts-from-api';
import type { ChannelPage } from './channel-thread-state';

const segment = encodeURIComponent;

/** The route's own default page size. */
const PAGE_SIZE = 50;

export const channelPaths = {
  /** The newest page of top-level posts, or the page older than `cursor`. */
  messages: (pageId: string, cursor?: string) => {
    const path = `/api/channels/${segment(pageId)}/messages?limit=${PAGE_SIZE}`;
    return cursor === undefined ? path : `${path}&cursor=${segment(cursor)}`;
  },
  /** Moves the viewer's read watermark to now. */
  read: (pageId: string) => `/api/channels/${segment(pageId)}/read`,
};

/** One page of a channel's posts, oldest first, as the viewer sees them. */
export const fetchChannelPage = async (
  client: ApiClient,
  { pageId, viewerId, cursor }: { readonly pageId: string; readonly viewerId: string; readonly cursor?: string },
): Promise<ChannelPage> => {
  const page = await client.apiFetch<ChannelMessagesResponse>(channelPaths.messages(pageId, cursor));
  return {
    posts: postsFrom(page.messages, viewerId),
    nextCursor: page.hasMore ? page.nextCursor : null,
    lastReadAt: page.lastReadAt ?? null,
  };
};

/** Marks the channel read for the viewer; apps/web then clears its unread everywhere. */
export const markChannelRead = async (client: ApiClient, pageId: string): Promise<void> => {
  await client.apiFetch(channelPaths.read(pageId), { method: 'POST', json: {} });
};
