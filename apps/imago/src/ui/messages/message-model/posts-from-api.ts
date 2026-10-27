// apps/web's channel messages, mapped into imago's posts.

import type { ChannelMessageResponse, ChannelReactionResponse, Post, PostReaction } from './post';

export const UNKNOWN_USER = 'Unknown user';

/** Each emoji once, in the order it was first used, with everyone who used it. */
export const reactionsOf = (rows: readonly ChannelReactionResponse[], viewerId: string): readonly PostReaction[] => {
  const ordered = [...rows].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const emojis = [...new Set(ordered.map((row) => row.emoji))];
  return emojis.map((emoji) => {
    const used = ordered.filter((row) => row.emoji === emoji);
    return {
      emoji,
      count: used.length,
      names: used.map((row) => row.user.name || UNKNOWN_USER),
      mine: used.some((row) => row.userId === viewerId),
    };
  });
};

/**
 * Top-level posts as the viewer sees them. An agent or webhook posts under a
 * user's id, so it is named and grouped as itself. Unread follows apps/web's
 * count (api/inbox): someone else's post, or any agent's, even the viewer's own.
 */
export const postsFrom = (messages: readonly ChannelMessageResponse[], viewerId: string): readonly Post[] =>
  messages.map((message) => {
    const { aiMeta } = message;
    return {
      id: message.id,
      authorKey:
        aiMeta === null
          ? message.userId
          : `${message.userId}:${aiMeta.senderType}:${aiMeta.agentPageId ?? aiMeta.senderName}`,
      authorName: aiMeta?.senderName || message.user.name || UNKNOWN_USER,
      authorImage: aiMeta === null ? message.user.image : null,
      agent: aiMeta !== null,
      countsAsUnread: message.userId !== viewerId || aiMeta?.senderType === 'agent',
      at: message.createdAt,
      text: message.content,
      edited: message.editedAt !== null,
      reactions: reactionsOf(message.reactions, viewerId),
    };
  });
