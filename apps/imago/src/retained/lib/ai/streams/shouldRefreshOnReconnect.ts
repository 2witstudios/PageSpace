export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * True when the socket has just transitioned from a non-connected state to
 * `connected` AND the surface has already seen its initial connect. Surfaces
 * call this on every connection-status change to decide whether to refresh
 * their conversation; the `hadInitialConnect` flag suppresses the refresh on
 * the very first connect (already covered by the surface's mount-time load).
 */
export const shouldRefreshOnReconnect = (
  prevStatus: ConnectionStatus | null,
  currStatus: ConnectionStatus,
  hadInitialConnect: boolean,
): boolean =>
  prevStatus !== 'connected' && currStatus === 'connected' && hadInitialConnect;
