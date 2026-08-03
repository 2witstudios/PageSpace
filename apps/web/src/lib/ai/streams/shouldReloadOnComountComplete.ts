import type { PendingStream } from '@/stores/usePendingStreamsStore';

// Returns true when a co-mounted surface should reload from DB to sync after a same-session stream completes.
// `cacheHasFinalMessage`: the completed message already sits in the conversation cache as a
// non-streaming row (the sender's own onFinish commit — see buildOwnStreamCommitOnFinish), so a
// full reload would only add a loading flip for content the cache already holds.
export function shouldReloadOnComountComplete(
  stream: PendingStream | undefined,
  completedConvId: string | undefined,
  activeConversationId: string | null,
  cacheHasFinalMessage: boolean,
): boolean {
  if (!completedConvId || !activeConversationId) return false;
  if (completedConvId !== activeConversationId) return false;
  if (cacheHasFinalMessage) return false;
  if (stream && stream.parts.length > 0) return false;
  return true;
}
