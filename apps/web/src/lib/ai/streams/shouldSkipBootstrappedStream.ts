/**
 * Bootstrap may surface a messageId that's already finalized via the live
 * socket path (race) or already being consumed (effect re-run before cleanup
 * settled). True means the bootstrap loop should skip this stream.
 *
 * `processed` accepts anything with a `.has()` — the caller's `processed` is a
 * `Map<string, boolean>` (messageId -> was the fire authoritative), not a
 * `Set<string>`, since PR 6's fireComplete needs to track that to allow an
 * authoritative chat:stream_complete to upgrade an earlier local-only finalize.
 */
export const shouldSkipBootstrappedStream = (
  messageId: string,
  processed: { has: (messageId: string) => boolean },
  controllers: ReadonlyMap<string, unknown>,
): boolean => processed.has(messageId) || controllers.has(messageId);
