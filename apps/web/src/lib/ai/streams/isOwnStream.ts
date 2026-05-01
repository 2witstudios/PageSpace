/**
 * True when a stream's `triggeredBy.browserSessionId` matches the local browser
 * session — i.e. the stream originated in this tab. Streams that don't match
 * are either from another user, another tab of the same user, or from a server
 * action with no associated session.
 */
export const isOwnStream = (
  triggeredBy: { browserSessionId: string },
  localBrowserSessionId: string,
): boolean => triggeredBy.browserSessionId === localBrowserSessionId;
