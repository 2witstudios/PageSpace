'use client';
import { useEffect } from 'react';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { usePendingStreamsStore } from '@/retained/stores/usePendingStreamsStore';
import type { StreamingPhase } from '@/ui/chat/chat-plugin';
import { dispatch, transactions } from '@/ui/store/transactions';

/**
 * Where a conversation's turn is: thinking while its send waits, speaking once the viewer's own
 * stream into it runs. Sends and streams are keyed by conversation only, so the caller says
 * which conversation is Imago's.
 */
export const phaseOf = (
  conversationId: string | null,
  pending: ReadonlySet<string>,
  ownStreams: readonly string[],
): StreamingPhase | null => {
  if (conversationId === null) return null;
  if (ownStreams.includes(conversationId)) return 'speaking';
  return pending.has(conversationId) ? 'thinking' : null;
};

/** Reports the turn in Imago's shown conversation to the shell, for its orb; null when not Imago's. */
export function useImagoPhase(conversationId: string | null): void {
  const pending = useEditingStore(state => state.pendingSends);
  const own = usePendingStreamsStore(state => [...state.streams.values()].filter(stream => stream.isOwn)
    .map(stream => stream.conversationId).sort().join(','));
  const phase = phaseOf(conversationId, pending, own === '' ? [] : own.split(','));
  // Only Imago's chat writes the phase, so another agent's chat mounting never clears it.
  const active = conversationId !== null;
  useEffect(() => {
    if (!active) return;
    dispatch(transactions.setStreamingPhase, phase);
    return () => dispatch(transactions.setStreamingPhase, null);
  }, [active, phase]);
}
