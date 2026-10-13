// A DM conversation's messages: apps/web's answer, and imago's posts of it.
//
// DmMessageResponse is the fields imago reads of a direct_messages row as
// /api/messages/[conversationId] answers it: GET joins the `sender` and the
// `reactions`; the POST's answer and realtime's `new_dm_message` broadcast
// carry the bare row, so a post from them may not name its author yet. A DM
// has two people, so the thread names them from what it knows (namedPosts).

import type { ChannelReactionResponse, Post } from './post';
import { reactionsOf, UNKNOWN_USER } from './posts-from-api';
import type { ReceivedPost } from './received';

export type DmMessageResponse = {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  /** Plain text; mentions are stored inline as `@[label](id:type)`. */
  readonly content: string;
  readonly createdAt: string;
  readonly isEdited: boolean;
  readonly editedAt: string | null;
  readonly parentId: string | null;
  readonly sender?: { readonly id: string; readonly name: string | null; readonly image: string | null } | null;
  /** The same rows as a channel post's (dm_message_reactions with its `user`). */
  readonly reactions?: readonly ChannelReactionResponse[];
  /** What the sender's POST carried, echoed so the sender can retire its sending post. Never stored. */
  readonly clientNonce?: string;
};

/** GET /api/messages/[conversationId]: the newest page (or the page `before` a time), oldest first. */
export type DmMessagesResponse = { readonly messages: readonly DmMessageResponse[] };

/** POST /api/messages/[conversationId]: the stored message. */
export type DmSendResponse = { readonly message: DmMessageResponse };

/**
 * DM messages as the viewer sees them. An author the row does not name gets
 * an empty name until namedPosts fills it. Unread is someone else's message.
 */
export const dmPostsFrom = (messages: readonly DmMessageResponse[], viewerId: string): readonly Post[] =>
  messages.map((message) => ({
    id: message.id,
    authorKey: message.senderId,
    authorName: message.sender?.name ?? '',
    authorImage: message.sender?.image ?? null,
    agent: false,
    countsAsUnread: message.senderId !== viewerId,
    at: message.createdAt,
    text: message.content,
    edited: message.isEdited || message.editedAt !== null,
    reactions: reactionsOf(message.reactions ?? [], viewerId),
  }));

export const dmReceivedFrom = (message: DmMessageResponse, viewerId: string): ReceivedPost => {
  const [post] = dmPostsFrom([message], viewerId) as [Post];
  const mine = message.senderId === viewerId;
  return typeof message.clientNonce === 'string' ? { post, nonce: message.clientNonce, mine } : { post, mine };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

/** The fields of a broadcast imago reads, checked: realtime relays whatever was posted to it. */
const asDmMessage = (payload: unknown): DmMessageResponse | null => {
  if (!isRecord(payload)) return null;
  const { id, conversationId, senderId, content, createdAt, sender, reactions } = payload;
  if (!isString(id) || !isString(conversationId) || !isString(senderId) || !isString(content) || !isString(createdAt))
    return null;
  return {
    id,
    conversationId,
    senderId,
    content,
    createdAt,
    isEdited: payload.isEdited === true,
    editedAt: isString(payload.editedAt) ? payload.editedAt : null,
    parentId: isString(payload.parentId) ? payload.parentId : null,
    sender: isRecord(sender)
      ? {
          id: senderId,
          name: isString(sender.name) ? sender.name : null,
          image: isString(sender.image) ? sender.image : null,
        }
      : null,
    reactions: Array.isArray(reactions) ? (reactions as DmMessageResponse['reactions']) : [],
    ...(isString(payload.clientNonce) ? { clientNonce: payload.clientNonce } : {}),
  };
};

/**
 * A `new_dm_message` broadcast as a post of the open conversation, or null
 * when it is not one the thread shows: another conversation's, a thread
 * reply (the main stream is top-level only, as classic), or not a message.
 */
export const liveDmPost = (
  payload: unknown,
  { conversationId, viewerId }: { readonly conversationId: string; readonly viewerId: string },
): ReceivedPost | null => {
  const message = asDmMessage(payload);
  if (message === null || message.conversationId !== conversationId || message.parentId !== null) return null;
  return dmReceivedFrom(message, viewerId);
};

/** Who a DM's posts may be by, as far as imago knows them. */
export type DmPerson = { readonly name: string; readonly image: string | null };

/**
 * Names every post: the name a stored post of the same author carried, else the
 * person given for them (the other participant from the conversation list),
 * else "You" for the viewer, else "Unknown user".
 */
export const namedPosts = (
  posts: readonly Post[],
  { viewerId, people }: { readonly viewerId: string; readonly people: Readonly<Record<string, DmPerson>> },
): readonly Post[] => {
  const known = new Map<string, DmPerson>(Object.entries(people));
  // A sending post's name is only a guess at the viewer's.
  for (const post of posts)
    if (post.authorName !== '' && post.pending !== true) known.set(post.authorKey, { name: post.authorName, image: post.authorImage });
  return posts.map((post) => {
    if (post.authorName !== '') return post;
    const person = known.get(post.authorKey);
    if (person) return { ...post, authorName: person.name, authorImage: person.image };
    return { ...post, authorName: post.authorKey === viewerId ? 'You' : UNKNOWN_USER };
  });
};
