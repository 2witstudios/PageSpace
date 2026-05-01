/**
 * The synthetic socket-room/channel id used by the global assistant pipeline.
 * Construct via `globalChannelId(userId)`; parse via `parseGlobalChannelId`.
 *
 * Format: `user:${userId}:global`. The format is positional, not delimited,
 * so userIds containing `:` round-trip correctly through both functions.
 */
const GLOBAL_PREFIX = 'user:';
const GLOBAL_SUFFIX = ':global';

export const globalChannelId = (userId: string): string =>
  `${GLOBAL_PREFIX}${userId}${GLOBAL_SUFFIX}`;

export const parseGlobalChannelId = (channelId: string): string | null => {
  if (!channelId.startsWith(GLOBAL_PREFIX)) return null;
  if (!channelId.endsWith(GLOBAL_SUFFIX)) return null;
  return channelId.slice(GLOBAL_PREFIX.length, channelId.length - GLOBAL_SUFFIX.length);
};
