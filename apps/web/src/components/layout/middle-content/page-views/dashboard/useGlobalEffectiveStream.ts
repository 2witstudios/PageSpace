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
}: UseGlobalEffectiveStreamArgs): GlobalEffectiveStream {
  const inGlobalMode = !selectedAgent;
  const effectiveIsStreaming = inGlobalMode
    ? localIsStreaming || contextIsStreaming
    : localIsStreaming;

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
    // Idle locally but resumed via bootstrap after refresh: use the context's
    // messageId-based stop registered at bootstrap.
    if (inGlobalMode && contextStopStreaming) {
      contextStopStreaming();
    }
  }, [activeMessageId, localIsStreaming, rawStop, inGlobalMode, contextStopStreaming]);

  return { effectiveIsStreaming, effectiveStop };
}
