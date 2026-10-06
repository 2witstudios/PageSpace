// A channel post arriving after the channel loaded: the answer to the
// viewer's own send, or a new_message broadcast from realtime.

import type { ChannelMessageResponse, Post } from './post';
import { postsFrom } from './posts-from-api';

export type ReceivedPost = {
  readonly post: Post;
  /** The nonce the sender's POST carried, when the server echoed one. */
  readonly nonce?: string;
  /** The viewer posted it: only then may its nonce retire a sending post. */
  readonly mine: boolean;
};

export const receivedFrom = (message: ChannelMessageResponse, viewerId: string): ReceivedPost => {
  const [post] = postsFrom([message], viewerId) as [Post];
  const mine = message.userId === viewerId;
  return typeof message.clientNonce === 'string' ? { post, nonce: message.clientNonce, mine } : { post, mine };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

/** The fields of a broadcast imago reads, checked: realtime relays whatever was posted to it. */
const asChannelMessage = (payload: unknown): ChannelMessageResponse | null => {
  if (!isRecord(payload)) return null;
  const { id, content, createdAt, pageId, userId, user, reactions } = payload;
  if (!isString(id) || !isString(content) || !isString(createdAt) || !isString(pageId) || !isString(userId)) return null;
  if (!isRecord(user)) return null;
  return {
    ...(payload as ChannelMessageResponse),
    editedAt: isString(payload.editedAt) ? payload.editedAt : null,
    aiMeta: isRecord(payload.aiMeta) ? (payload.aiMeta as ChannelMessageResponse['aiMeta']) : null,
    parentId: isString(payload.parentId) ? payload.parentId : null,
    user: {
      id: isString(user.id) ? user.id : userId,
      name: isString(user.name) ? user.name : null,
      image: isString(user.image) ? user.image : null,
    },
    reactions: Array.isArray(reactions) ? (reactions as ChannelMessageResponse['reactions']) : [],
  };
};

/**
 * A `new_message` broadcast as a post of the open channel, or null when it
 * is not one the thread shows: another channel's (the tab may still be in
 * its room), a thread reply, or not a post at all.
 */
export const liveChannelPost = (
  payload: unknown,
  { pageId, viewerId }: { readonly pageId: string; readonly viewerId: string },
): ReceivedPost | null => {
  const message = asChannelMessage(payload);
  if (message === null || message.pageId !== pageId || message.parentId !== null) return null;
  return receivedFrom(message, viewerId);
};
