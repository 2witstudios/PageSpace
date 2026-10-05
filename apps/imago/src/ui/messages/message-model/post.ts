// A channel's posts: apps/web's answer, and imago's model of it.
//
// The *Response types are the fields imago reads of what
// GET /api/channels/[pageId]/messages returns (the channel_messages row with
// the `user` and `reactions` relations of channel-message-repository's
// messageWith, as packages/sdk's channelMessageSchema mirrors it). The route
// returns more (attachments, quotes, threads); imago does not read those yet.

/** Set when an AI tool or a webhook posted the message. */
export type ChannelMessageAiMetaResponse = {
  readonly senderType: 'global_assistant' | 'agent' | 'webhook';
  readonly senderName: string;
  readonly agentPageId?: string;
};

export type ChannelReactionResponse = {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly emoji: string;
  readonly createdAt: string;
  readonly user: { readonly id: string; readonly name: string | null };
};

export type ChannelMessageResponse = {
  readonly id: string;
  /** Plain text; mentions are stored inline as `@[label](id:type)`. */
  readonly content: string;
  readonly createdAt: string;
  readonly pageId: string;
  readonly userId: string;
  readonly editedAt: string | null;
  readonly aiMeta: ChannelMessageAiMetaResponse | null;
  readonly parentId: string | null;
  readonly replyCount: number;
  readonly user: { readonly id: string; readonly name: string | null; readonly image: string | null };
  readonly reactions: readonly ChannelReactionResponse[];
};

/** One page of a channel, oldest post first; `nextCursor` reaches older posts. */
export type ChannelMessagesResponse = {
  readonly messages: readonly ChannelMessageResponse[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** UTC ISO: the viewer has read the channel up to here; null if never. */
  readonly lastReadAt?: string | null;
};

/** One emoji on a post, with everyone who used it. */
export type PostReaction = {
  readonly emoji: string;
  readonly count: number;
  readonly names: readonly string[];
  /** The viewer is among them. */
  readonly mine: boolean;
};

/** A top-level channel post, ready to group and draw. */
export type Post = {
  readonly id: string;
  /** Who a group belongs to: the user, or the agent or webhook posting as them. */
  readonly authorKey: string;
  readonly authorName: string;
  readonly authorImage: string | null;
  /** Posted by an agent or webhook rather than typed by a person. */
  readonly agent: boolean;
  /** Whether apps/web counts this post toward the viewer's unread. */
  readonly countsAsUnread: boolean;
  /** UTC ISO. */
  readonly at: string;
  readonly text: string;
  readonly edited: boolean;
  readonly reactions: readonly PostReaction[];
};
