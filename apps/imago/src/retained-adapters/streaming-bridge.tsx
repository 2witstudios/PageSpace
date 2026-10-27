'use client';
import { useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { usePendingStreamsStore } from '@/retained/stores/usePendingStreamsStore';
import { dispatch, transactions } from '@/ui/store/transactions';

/** Mirror lifecycle only; message parts and stream ownership remain in the retained store. */
export function StreamingBridge() {
  const pending = useEditingStore(state => [...state.pendingSends].sort().join(','));
  const own = usePendingStreamsStore(state => [...state.streams.values()].filter(stream => stream.isOwn)
    .map(stream => stream.conversationId).sort().join(','));
  const id = (pending || own).split(',')[0] || null;
  const previous = useRef<string | null>(null);
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (previous.current === id) return;
    if (previous.current) {
      dispatch(transactions.endStreaming, previous.current);
      void mutate(key => (Array.isArray(key) && key[0] === 'imago:agent-conversations') || (typeof key === 'string' && key.startsWith('/api/ai/page-agents/') && key.includes('/conversations?')));
    }
    if (id) dispatch(transactions.startStreaming, id);
    previous.current = id;
  }, [id, mutate]);
  return null;
}
