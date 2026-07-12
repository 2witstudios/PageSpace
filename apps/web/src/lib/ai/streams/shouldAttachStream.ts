/**
 * Decides whether a client should subscribe to a server stream it has just
 * learned about (from a live `chat:stream_start`, or from the DB bootstrap).
 *
 * Streams are server-owned; a client is a subscriber. The one and only reason
 * to decline a subscription is that this browser context is ALREADY consuming
 * the very same stream over the POST response body — attaching twice would
 * render every token twice.
 *
 * `isOwn` alone is not sufficient (that was the bug): `browserSessionId` lives
 * in `sessionStorage` and survives a reload, so a reloaded tab still looks like
 * the originator while consuming nothing.
 *
 * `isConsuming` alone is not sufficient either: it is keyed by channel, and a
 * page channel carries streams from other users and other conversations. A tab
 * consuming its own stream must still attach to a *remote* one on the same
 * channel, or multiplayer goes dark.
 *
 * So: decline only when both are true.
 */
export const shouldAttachStream = ({
  isOwn,
  isConsuming,
}: {
  /** The stream was triggered by this browser session (`triggeredBy.browserSessionId`). */
  isOwn: boolean;
  /** This browser context is currently reading a stream body for the stream's channel. */
  isConsuming: boolean;
}): boolean => !(isOwn && isConsuming);
