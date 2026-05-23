import type { PendingStream } from '@/stores/usePendingStreamsStore';

/**
 * Returns true when a co-mounted surface should reload its messages from DB
 * after receiving a chat:stream_complete event for its active conversation.
 *
 * This fires when a stream was driven by a different surface in the same
 * browser session (e.g. middle panel streamed while sidebar was watching
 * the same conversation). Because own-session socket events are filtered by
 * isOwnStream, the non-sending surface never gets the messages directly —
 * it must reload from DB to stay in sync.
 *
 * Returns false when a pending stream entry exists with parts (meaning the
 * normal synthesize-from-store path should handle it instead).
 */
export function shouldReloadOnComountComplete(
  stream: PendingStream | undefined,
  completedConvId: string | undefined,
  activeConversationId: string | null,
): boolean {
  if (!completedConvId || !activeConversationId) return false;
  if (completedConvId !== activeConversationId) return false;
  if (stream && stream.parts.length > 0) return false;
  return true;
}
