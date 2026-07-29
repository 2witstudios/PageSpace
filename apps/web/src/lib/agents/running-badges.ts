/**
 * Which rows in the Agents tree get a "running" dot.
 *
 * Pure data in, pure data out: `useUserActiveStreams` does the polling and hands
 * the rows here, so the decision about what counts as running — and, more
 * importantly, WHICH agent a stream belongs to — is testable without a fetch.
 *
 * The one structural choice worth stating: agent attribution comes from the
 * stream's own `channelId`, not from walking the conversation map. A collapsed
 * agent row has never loaded its conversations, so a conversation-derived
 * attribution would leave a background run invisible until the user happened to
 * expand exactly the right row — the opposite of what a badge is for.
 */

import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';

/**
 * One row of `GET /api/ai/chat/active-streams?scope=user`. That mode answers
 * "what is streaming", not "render its content", so it carries no `parts` — see
 * the route for why.
 */
export interface UserActiveStream {
  messageId: string;
  conversationId: string;
  /**
   * The socket channel the stream is on. For an agent conversation this IS the
   * agent's page id; for the global assistant it is the synthetic
   * `user:{userId}:global` id, which belongs to no agent.
   */
  channelId: string;
  startedAt: string;
}

export interface RunningBadges {
  /**
   * conversationId → live stream count, restricted to the conversations the
   * caller actually renders. Quiet conversations are ABSENT rather than zero, so
   * a row's read is one truthiness check.
   */
  byConversation: Record<string, number>;
  /**
   * agentPageId → live stream count across ALL of that agent's conversations,
   * including ones the caller has never loaded. Global-assistant streams
   * contribute to no agent.
   */
  byAgent: Record<string, number>;
}

const EMPTY_BADGES: RunningBadges = { byConversation: {}, byAgent: {} };

/**
 * @param activeStreams the caller's own in-flight streams, cross-channel.
 * @param conversationIds the conversation rows currently rendered — the bound on
 *   `byConversation`. Passing the rendered set (rather than building a map of
 *   every streaming conversation in the account) keeps the map the size of the
 *   tree, and makes it explicit that a conversation the sidebar has never heard
 *   of is still allowed to light its agent.
 */
export function deriveRunningBadges(
  activeStreams: readonly UserActiveStream[] | undefined,
  conversationIds: readonly string[] | undefined,
): RunningBadges {
  if (!activeStreams || activeStreams.length === 0) return EMPTY_BADGES;

  const rendered = new Set((conversationIds ?? []).filter(Boolean));
  const byConversation: Record<string, number> = {};
  const byAgent: Record<string, number> = {};

  for (const stream of activeStreams) {
    if (stream.conversationId && rendered.has(stream.conversationId)) {
      byConversation[stream.conversationId] = (byConversation[stream.conversationId] ?? 0) + 1;
    }
    // `parseGlobalChannelId` returns a userId for the global assistant's
    // synthetic channel and null for a real page id — so a null parse is
    // exactly "this channel is an agent page".
    if (stream.channelId && parseGlobalChannelId(stream.channelId) === null) {
      byAgent[stream.channelId] = (byAgent[stream.channelId] ?? 0) + 1;
    }
  }

  return { byConversation, byAgent };
}
