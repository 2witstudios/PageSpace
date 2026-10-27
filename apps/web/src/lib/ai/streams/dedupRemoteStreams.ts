import type { PendingStream } from '@/stores/usePendingStreamsStore';

/**
 * Drops any pending stream whose `messageId` already appears in the local
 * messages array. Surfaces that render remote streams alongside local
 * messages need this so they don't show the same message twice during the
 * brief window when the message has landed in `messages` but the stream
 * entry hasn't yet been removed from the store.
 */
export const dedupRemoteStreams = (
  streams: readonly PendingStream[],
  messages: readonly { id: string }[],
): PendingStream[] => {
  if (streams.length === 0) return [];
  const seen = new Set(messages.map((m) => m.id));
  return streams.filter((s) => !seen.has(s.messageId));
};
