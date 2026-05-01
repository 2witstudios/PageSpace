/**
 * Bootstrap may surface a messageId that's already finalized via the live
 * socket path (race) or already being consumed (effect re-run before cleanup
 * settled). True means the bootstrap loop should skip this stream.
 */
export const shouldSkipBootstrappedStream = (
  messageId: string,
  processed: ReadonlySet<string>,
  controllers: ReadonlyMap<string, unknown>,
): boolean => processed.has(messageId) || controllers.has(messageId);
