import { useCallback } from 'react';

interface UseGlobalEffectiveStreamArgs {
  localIsStreaming: boolean;
  rawStop: () => void;
  selectedAgent: { id: string } | null;
  contextIsStreaming: boolean;
  contextStopStreaming: (() => void) | null;
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
}: UseGlobalEffectiveStreamArgs): GlobalEffectiveStream {
  const inGlobalMode = !selectedAgent;
  const effectiveIsStreaming = inGlobalMode
    ? localIsStreaming || contextIsStreaming
    : localIsStreaming;

  const effectiveStop = useCallback(() => {
    if (localIsStreaming) {
      rawStop();
      return;
    }
    if (inGlobalMode && contextStopStreaming) {
      contextStopStreaming();
    }
  }, [localIsStreaming, rawStop, inGlobalMode, contextStopStreaming]);

  return { effectiveIsStreaming, effectiveStop };
}
