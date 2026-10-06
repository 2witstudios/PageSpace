// A DM conversation's messages and its read mark, through imago's API client,
// on the routes apps/web already has. apps/web answers 404 to anyone who is
// not one of the conversation's two participants.

import type { ApiClient } from '@/api/client';
import { DM_ROOM } from '@/realtime/realtime-provider';
import {
  dmPostsFrom,
  dmReceivedFrom,
  liveDmPost,
  type DmMessagesResponse,
  type DmSendResponse,
} from '../message-model/dm-message';
import type { ReceivedPost } from '../message-model/received';
import type { ThreadPage } from '../thread/thread-state';
import type { ThreadKind } from '../thread/use-thread';

const segment = encodeURIComponent;

/** The route's own default page size. */
const PAGE_SIZE = 50;

export const dmPaths = {
  /** The newest page of top-level messages, or the page sent before `before` (UTC ISO). */
  messages: (conversationId: string, before?: string) => {
    const path = `/api/messages/${segment(conversationId)}?limit=${PAGE_SIZE}`;
    return before === undefined ? path : `${path}&before=${segment(before)}`;
  },
  /** Where a new message is sent (POST) and the conversation marked read (PATCH). */
  conversation: (conversationId: string) => `/api/messages/${segment(conversationId)}`,
};

/**
 * One page of a conversation, oldest first. The route pages by time and says
 * nothing of more: a full page may have more before its oldest message. It
 * marks the conversation read as it answers and carries no watermark, so the
 * newest message it returned is where the viewer has read to: nothing loaded
 * is New, and what arrives live after it is.
 */
export const fetchDmPage = async (
  client: ApiClient,
  { conversationId, viewerId, before }: { readonly conversationId: string; readonly viewerId: string; readonly before?: string },
): Promise<ThreadPage> => {
  const { messages } = await client.apiFetch<DmMessagesResponse>(dmPaths.messages(conversationId, before));
  return {
    posts: dmPostsFrom(messages, viewerId),
    nextCursor: messages.length === PAGE_SIZE ? (messages[0]?.createdAt ?? null) : null,
    lastReadAt: messages.at(-1)?.createdAt ?? null,
  };
};

/** Marks the conversation read for the viewer; apps/web then clears its unread everywhere. */
export const markDmRead = async (client: ApiClient, conversationId: string): Promise<void> => {
  await client.apiFetch(dmPaths.conversation(conversationId), { method: 'PATCH', json: {} });
};

/**
 * Sends `content` to the conversation as the viewer, exactly as typed.
 * apps/web checks the viewer is a participant and not blocked, stores it,
 * broadcasts it to the conversation's room, and answers with the stored
 * message and the nonce echoed, which is how the sending post is matched.
 */
export const sendDmMessage = async (
  client: ApiClient,
  {
    conversationId,
    viewerId,
    content,
    clientNonce,
  }: { readonly conversationId: string; readonly viewerId: string; readonly content: string; readonly clientNonce: string },
): Promise<ReceivedPost> => {
  const { message } = await client.apiFetch<DmSendResponse>(dmPaths.conversation(conversationId), {
    method: 'POST',
    json: { content, clientNonce },
  });
  return dmReceivedFrom(message, viewerId);
};

/** realtime's event for a DM message (apps/web's DM messages route broadcasts it). */
export const NEW_DM_MESSAGE = 'new_dm_message';

/** A DM conversation as an open thread: its messages, its read mark and its realtime room. */
export const dmThread: ThreadKind = {
  fetchPage: (client, { threadId, viewerId, cursor }) =>
    fetchDmPage(client, { conversationId: threadId, viewerId, ...(cursor === undefined ? {} : { before: cursor }) }),
  send: (client, { threadId, ...message }) => sendDmMessage(client, { conversationId: threadId, ...message }),
  markRead: markDmRead,
  loadMarksRead: true,
  room: DM_ROOM,
  event: NEW_DM_MESSAGE,
  live: (payload, { threadId, viewerId }) => liveDmPost(payload, { conversationId: threadId, viewerId }),
  sendFailed: 'Could not send your message.',
};
