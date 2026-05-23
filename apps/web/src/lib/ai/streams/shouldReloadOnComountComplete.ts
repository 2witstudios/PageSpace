import type { PendingStream } from '@/stores/usePendingStreamsStore';

// Returns true when a co-mounted surface should reload from DB to sync after a same-session stream completes.
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
