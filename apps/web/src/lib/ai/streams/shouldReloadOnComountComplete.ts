import type { PendingStream } from '@/stores/usePendingStreamsStore';

// Returns true when a surface should reload from DB to sync after a same-session stream
// completes. The caller (conversationCacheSocketHandlers) has already established the
// completed conversation is cached — this decides only whether a reload adds anything:
// `cacheHasFinalMessage`: the completed message already sits in the cache as a row whose
// terminal status is consistent with the event (the sender's own onFinish commit — see
// buildOwnStreamCommitOnFinish / cacheHasConsistentFinalMessage), so a reload would only
// add a loading flip for content the cache already holds.
// A stream entry with parts means the commit branch owned the completion; zero-parts or
// missing entries fall through to the reload.
export function shouldReloadOnComountComplete(
  stream: PendingStream | undefined,
  cacheHasFinalMessage: boolean,
): boolean {
  if (cacheHasFinalMessage) return false;
  if (stream && stream.parts.length > 0) return false;
  return true;
}
