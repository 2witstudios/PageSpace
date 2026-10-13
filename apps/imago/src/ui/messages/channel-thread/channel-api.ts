// A channel's posts and its read mark, through imago's API client, on the
// routes apps/web already has. Access is decided there.

import type { ApiClient } from '@/api/client';
import { CHANNEL_ROOM } from '@/realtime/realtime-provider';
import type { ChannelMessageResponse, ChannelMessagesResponse } from '../message-model/post';
import { postsFrom } from '../message-model/posts-from-api';
import { liveChannelPost, receivedFrom, type ReceivedPost } from '../message-model/received';
import type { ThreadPage } from '../thread/thread-state';
import type { ThreadKind } from '../thread/use-thread';

const segment = encodeURIComponent;

/** The route's own default page size. */
const PAGE_SIZE = 50;

export const channelPaths = {
  /** The newest page of top-level posts, or the page older than `cursor`. */
  messages: (pageId: string, cursor?: string) => {
    const path = `/api/channels/${segment(pageId)}/messages?limit=${PAGE_SIZE}`;
    return cursor === undefined ? path : `${path}&cursor=${segment(cursor)}`;
  },
  /** Where a new top-level post is sent. */
  send: (pageId: string) => `/api/channels/${segment(pageId)}/messages`,
  /** Moves the viewer's read watermark to now. */
  read: (pageId: string) => `/api/channels/${segment(pageId)}/read`,
  /** What the viewer may do on the channel's page. */
  permissions: (pageId: string) => `/api/pages/${segment(pageId)}/permissions/check`,
};

/** One page of a channel's posts, oldest first, as the viewer sees them. */
export const fetchChannelPage = async (
  client: ApiClient,
  { pageId, viewerId, cursor }: { readonly pageId: string; readonly viewerId: string; readonly cursor?: string },
): Promise<ThreadPage> => {
  const page = await client.apiFetch<ChannelMessagesResponse>(channelPaths.messages(pageId, cursor));
  return {
    posts: postsFrom(page.messages, viewerId),
    nextCursor: page.hasMore ? page.nextCursor : null,
    lastReadAt: page.lastReadAt ?? null,
  };
};

/**
 * Whether the viewer may post in the channel: apps/web lets a member with
 * edit permission post (the channel route's own check), as classic
 * ChannelView reads it.
 */
export const fetchCanPost = async (client: ApiClient, pageId: string): Promise<boolean> => {
  const permissions = await client.apiFetch<{ readonly canEdit: boolean }>(channelPaths.permissions(pageId));
  return permissions.canEdit === true;
};

/** Marks the channel read for the viewer; apps/web then clears its unread everywhere. */
export const markChannelRead = async (client: ApiClient, pageId: string): Promise<void> => {
  await client.apiFetch(channelPaths.read(pageId), { method: 'POST', json: {} });
};

/**
 * Posts `content` to the channel as the viewer, exactly as typed: a mention
 * is already in the stored `@[label](id:type)` form. apps/web checks the
 * viewer may post, stores it, broadcasts it, and answers with the stored post
 * and the nonce echoed, which is how the sending post is matched.
 */
export const sendChannelPost = async (
  client: ApiClient,
  {
    pageId,
    viewerId,
    content,
    clientNonce,
  }: { readonly pageId: string; readonly viewerId: string; readonly content: string; readonly clientNonce: string },
): Promise<ReceivedPost> => {
  const stored = await client.apiFetch<ChannelMessageResponse>(channelPaths.send(pageId), {
    method: 'POST',
    json: { content, clientNonce },
  });
  return receivedFrom(stored, viewerId);
};

/** realtime's event for a channel post (apps/web's channel messages route broadcasts it). */
export const NEW_MESSAGE = 'new_message';

/** A channel as an open thread: its posts, its read mark and its realtime room. */
export const channelThread: ThreadKind = {
  fetchPage: (client, { threadId, viewerId, cursor }) =>
    fetchChannelPage(client, { pageId: threadId, viewerId, ...(cursor === undefined ? {} : { cursor }) }),
  send: (client, { threadId, ...post }) => sendChannelPost(client, { pageId: threadId, ...post }),
  markRead: markChannelRead,
  loadMarksRead: false,
  room: CHANNEL_ROOM,
  event: NEW_MESSAGE,
  live: (payload, { threadId, viewerId }) => liveChannelPost(payload, { pageId: threadId, viewerId }),
  sendFailed: 'Could not send your post.',
};
