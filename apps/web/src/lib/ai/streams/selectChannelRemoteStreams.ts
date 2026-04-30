import type { PendingStream } from '@/stores/usePendingStreamsStore';

interface ChannelStreamsState {
  getRemotePageStreams: (channelId: string) => PendingStream[];
}

interface SelectArgs {
  selectedAgent: { id: string } | null;
  agentConversationId: string | null;
  globalChannelId: string | null;
  globalConversationId: string | null;
}

/**
 * Picks the right channel and applies the conversation filter for the surface
 * that's calling. Agent mode reads `selectedAgent.id`; global mode reads
 * `globalChannelId`. In either mode, streams whose `conversationId` doesn't
 * match the active conversation are dropped — concurrent streams in other
 * conversations on the same channel must not render here.
 *
 * Used by GlobalAssistantView and SidebarChatTab. The two surfaces had the
 * same dispatch + filter inline before; consolidating here keeps the
 * mode/conversation rules in one tested unit.
 */
export const selectChannelRemoteStreams = (
  state: ChannelStreamsState,
  { selectedAgent, agentConversationId, globalChannelId, globalConversationId }: SelectArgs,
): PendingStream[] => {
  if (selectedAgent) {
    if (!agentConversationId) return [];
    return state
      .getRemotePageStreams(selectedAgent.id)
      .filter((s) => s.conversationId === agentConversationId);
  }
  if (!globalChannelId || !globalConversationId) return [];
  return state
    .getRemotePageStreams(globalChannelId)
    .filter((s) => s.conversationId === globalConversationId);
};
