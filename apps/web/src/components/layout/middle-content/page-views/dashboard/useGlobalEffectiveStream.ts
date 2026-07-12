import { useCallback } from 'react';
import { abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';

interface UseGlobalEffectiveStreamArgs {
  localIsStreaming: boolean;
  rawStop: () => void;
  selectedAgent: { id: string } | null;
  contextIsStreaming: boolean;
  contextStopStreaming: (() => void) | null;
  /**
   * The stable assistant messageId of the live stream, when known. Aborting by
   * messageId reaches the server registry even if the conversation id shifted
   * mid-stream, and tears down any multicast SSE join. The bootstrap (refresh)
   * path is still served by `contextStopStreaming`.
   */
  activeMessageId?: string;
  /**
   * A bootstrap-restored AGENT stream, from the dashboard store (keyed by (agentId,
   * conversationId)). The global mode had this all along via the context; agent mode did not — so
   * after a refresh mid-agent-stream, `useAgentChannelMultiplayer` claimed the store slot, the
   * SIDEBAR read it and showed a working Stop, and the DASHBOARD — the surface that started the
   * stream — rendered Send. The user had no way to stop their own generation, and it kept running
   * and kept billing.
   */
  agentBootstrapIsStreaming?: boolean;
  agentBootstrapStop?: (() => void | Promise<void>) | null;
}

interface GlobalEffectiveStream {
  effectiveIsStreaming: boolean;
  effectiveStop: () => void;
}

/**
 * Bridges the local useChat stream with the GlobalChatContext stream so the
 * dashboard surfaces a stop button + streaming indicator after a refresh
 * mid-stream — the local hook starts at idle, but the context's bootstrap
 * may have detected an own in-flight stream and registered a stop function.
 *
 * Agent mode is intentionally pass-through: the context tracks Global Assistant
 * state only, and is irrelevant when an agent is selected.
 */
export function useGlobalEffectiveStream({
  localIsStreaming,
  rawStop,
  selectedAgent,
  contextIsStreaming,
  contextStopStreaming,
  activeMessageId,
  agentBootstrapIsStreaming = false,
  agentBootstrapStop = null,
}: UseGlobalEffectiveStreamArgs): GlobalEffectiveStream {
  const inGlobalMode = !selectedAgent;
  // Both modes now surface a bootstrap-restored stream, not just global. See
  // agentBootstrapIsStreaming: agent mode used to show Send after a refresh mid-stream.
  const effectiveIsStreaming = inGlobalMode
    ? localIsStreaming || contextIsStreaming
    : localIsStreaming || agentBootstrapIsStreaming;

  const effectiveStop = useCallback(() => {
    // Authoritative: abort by the stable assistant messageId when the live stream
    // is known — reaches the server registry regardless of conversation-id drift
    // and tears down any multicast SSE join. Also stop the local fetch.
    if (activeMessageId) {
      rawStop();
      void abortActiveStreamByMessageId({ messageId: activeMessageId });
      return;
    }
    // Streaming but no messageId yet (submitted, before first chunk): stop the
    // local fetch (rawStop also best-effort aborts by chatId).
    if (localIsStreaming) {
      rawStop();
      return;
    }
    // Idle locally but resumed via bootstrap after refresh: use the messageId-based stop the
    // bootstrap registered. Global mode reads it from the context; agent mode from the dashboard
    // store — and agent mode never used to, which is how the dashboard ended up with no Stop
    // button at all for a stream it had started itself.
    if (inGlobalMode && contextStopStreaming) {
      contextStopStreaming();
      return;
    }
    if (!inGlobalMode && agentBootstrapStop) {
      void agentBootstrapStop();
    }
  }, [
    activeMessageId,
    localIsStreaming,
    rawStop,
    inGlobalMode,
    contextStopStreaming,
    agentBootstrapStop,
  ]);

  return { effectiveIsStreaming, effectiveStop };
}
