import type { PendingStream } from '@/stores/usePendingStreamsStore';

// Returns true when a surface should reload from DB to sync after a same-session stream completes.
// `conversationCached`: the completed conversation has a real cache entry (some surface rendered it
// this session) — dispatch is by the EVENT's conversation, so this replaces the old single
// "active conversation" equality gate; an uncached conversation needs no reload (its eventual
// loader fetches the DB truth anyway).
// `cacheHasFinalMessage`: the completed message already sits in the conversation cache as a
// non-streaming row (the sender's own onFinish commit — see buildOwnStreamCommitOnFinish), so a
// full reload would only add a loading flip for content the cache already holds.
export function shouldReloadOnComountComplete(
  stream: PendingStream | undefined,
  completedConvId: string | undefined,
  conversationCached: boolean,
  cacheHasFinalMessage: boolean,
): boolean {
  if (!completedConvId || !conversationCached) return false;
  if (cacheHasFinalMessage) return false;
  if (stream && stream.parts.length > 0) return false;
  return true;
}
