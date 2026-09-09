import { ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON } from '@pagespace/lib/env-bridge/bridge-session';
import type { WebSocket } from 'ws';
import { logger } from '@pagespace/lib/logging/logger-config';
import { sessionService } from '@pagespace/lib/auth/session-service';

/**
 * Env-bridge connection registry — the socket a LOCAL environment's daemon
 * holds open to this replica, keyed by **envId** (Local Environments epic,
 * M1 · t07).
 *
 * Deliberately a sibling of `ws-connections.ts` (the desktop MCP bridge's
 * per-USER map) rather than a change to it: a user with two machines needs two
 * live sockets, and the desktop bridge's one-socket-per-user rule is exactly
 * right for the desktop app. The three properties that make the desktop map
 * safe are copied here verbatim and pinned by tests:
 *
 * - the stale-connection sweep (closed / expired-session / inactive sockets
 *   are dropped on an interval, so a socket that never said goodbye cannot
 *   leak);
 * - the 5-minute session revalidation (a revoked `env:bridge` token closes the
 *   socket within the interval even when nothing else notices);
 * - the **compare-and-swap on socket identity in `unregisterEnvConnection`**:
 *   a socket is removed only if it is STILL the env's live socket. A
 *   superseded socket closing late must never evict its replacement, and —
 *   the reason the guard is load-bearing here — must never cancel the live
 *   env's in-flight requests (`onEnvConnectionLost` fires only for the live
 *   socket).
 *
 * A socket is registered in `hello_pending` and becomes `authorized` only when
 * the route has verified the machine-signed hello. Server→daemon frames are
 * only ever sent to a socket `getAuthorizedEnvConnection` hands out.
 */

export type EnvConnectionState = 'hello_pending' | 'authorized';

export interface EnvConnectionMetadata {
  envId: string;
  /** The machine owner — whose `env:bridge` token this is. */
  userId: string;
  sessionId: string;
  enrollmentId: string;
  /** The machine public key pinned at enrollment (base64 SPKI) — results on this socket verify under it. */
  machinePublicKey: string;
  /** The server key id this enrollment pinned — grants on this socket are signed by it. */
  serverKeyId: string | null;
  sessionExpiresAt?: Date;
  connectedAt: Date;
  lastPing?: Date;
  fingerprint?: string;
  state: EnvConnectionState;
  wsToken?: string;
  lastRevalidated?: Date;
  /** When `lastSeenAt` was last persisted for this socket — pings persist at most once per heartbeat window. */
  lastSeenPersistedAt?: Date;
  /** STOP (GA wave 3): the `pausedAt` (ms) this socket already delivered a signed `pause` for — sent once per pause. */
  pauseSentForMs?: number;
}

export interface RegisterEnvConnectionInput {
  userId: string;
  sessionId: string;
  enrollmentId: string;
  machinePublicKey: string;
  serverKeyId: string | null;
  fingerprint?: string;
  sessionExpiresAt?: Date;
  wsToken?: string;
}

/** The close a superseded socket receives. 1000 (normal): the daemon must NOT treat it as a failure and reconnect into a fight with its replacement. */
export { ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON };

export const ENV_STALE_CONNECTION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const ENV_SESSION_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - revalidate sessions to detect revoked tokens

const connections = new Map<string, WebSocket>();
const connectionMetadata = new Map<WebSocket, EnvConnectionMetadata>();
const lostListeners = new Set<(envId: string, ws: WebSocket) => void>();

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Built on FIRST USE, never at import: this module sits in the drive-envs
 * runtime's import graph, and suites that stub the logging module must be able
 * to import that runtime without a logger existing yet.
 */
let wsLoggerInstance: ReturnType<typeof logger.child> | null = null;
function wsLogger(): ReturnType<typeof logger.child> {
  wsLoggerInstance ??= logger.child({ component: 'ws-env-connections' });
  return wsLoggerInstance;
}

/** Subscribe to "the env's LIVE socket is gone" — the bridge client cancels that env's pending requests on it. */
export function onEnvConnectionLost(listener: (envId: string, ws: WebSocket) => void): () => void {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

function emitLost(envId: string, ws: WebSocket): void {
  for (const listener of lostListeners) {
    try {
      listener(envId, ws);
    } catch (error) {
      wsLogger().error('Env connection lost listener threw', { envId, error: error instanceof Error ? error.message : String(error), action: 'lost_listener_error' });
    }
  }
}

/**
 * Register the env's socket. A previous socket for the SAME env is closed with
 * the documented supersede code — the newer wins. Its metadata is dropped now,
 * so its late `close` handler finds nothing to unregister (the CAS below).
 */
export function registerEnvConnection(envId: string, ws: WebSocket, input: RegisterEnvConnectionInput): void {
  const existing = connections.get(envId);
  if (existing && existing !== ws) {
    if (existing.readyState === 0 || existing.readyState === 1) {
      wsLogger().info('Closing existing env connection for new connection', { envId, action: 'close_existing' });
      try {
        existing.close(ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON);
      } catch (error) {
        wsLogger().warn('Error closing superseded env connection', { envId, error: error instanceof Error ? error.message : String(error), action: 'close_existing_error' });
      }
    }
    connectionMetadata.delete(existing);
  }

  connections.set(envId, ws);
  connectionMetadata.set(ws, {
    envId,
    userId: input.userId,
    sessionId: input.sessionId,
    enrollmentId: input.enrollmentId,
    machinePublicKey: input.machinePublicKey,
    serverKeyId: input.serverKeyId,
    sessionExpiresAt: input.sessionExpiresAt,
    connectedAt: new Date(),
    fingerprint: input.fingerprint,
    state: 'hello_pending',
    wsToken: input.wsToken,
  });

  wsLogger().info('Env connection registered', {
    envId,
    userId: input.userId,
    sessionId: input.sessionId,
    sessionExpiresAt: input.sessionExpiresAt?.toISOString(),
    totalConnections: connections.size,
    action: 'register',
  });
}

/**
 * Unregister a socket — ONLY if it is still the env's live socket (CAS on
 * identity). @returns true when the live socket was removed (listeners fired);
 * false for a superseded or already-removed socket (nothing else happens).
 */
export function unregisterEnvConnection(envId: string, ws: WebSocket): boolean {
  const current = connections.get(envId);
  const wasLive = current === ws;
  if (wasLive) {
    connections.delete(envId);
    wsLogger().info('Env connection unregistered', { envId, totalConnections: connections.size, action: 'unregister' });
  } else {
    wsLogger().debug('Skipped unregistering stale env connection', { envId, action: 'unregister_skipped', reason: 'not_active_connection' });
  }
  // Always clean up metadata for this specific WebSocket
  connectionMetadata.delete(ws);
  if (wasLive) emitLost(envId, ws);
  return wasLive;
}

/** The env's registered socket in ANY state — for close/cleanup paths, never for sending frames. */
export function getEnvConnection(envId: string): WebSocket | undefined {
  return connections.get(envId);
}

/** The env's socket IFF it has completed the signed hello and is open — the ONLY socket server→daemon frames may go to. */
export function getAuthorizedEnvConnection(envId: string): WebSocket | undefined {
  const ws = connections.get(envId);
  if (!ws) return undefined;
  const metadata = connectionMetadata.get(ws);
  if (!metadata || metadata.state !== 'authorized' || ws.readyState !== 1) return undefined;
  return ws;
}

export function getEnvConnectionMetadata(ws: WebSocket): EnvConnectionMetadata | undefined {
  return connectionMetadata.get(ws);
}

/** The route calls this once the machine-signed hello has verified. */
export function markEnvAuthorized(ws: WebSocket): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) metadata.state = 'authorized';
}

export function isEnvAuthorized(ws: WebSocket): boolean {
  return connectionMetadata.get(ws)?.state === 'authorized';
}

export function updateEnvLastPing(ws: WebSocket): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) metadata.lastPing = new Date();
}

/** STOP (GA wave 3): this socket delivered the pause stamped at `pausedAtMs`; the PATCH and heartbeat paths both check it so a pause is sent exactly once per socket. */
export function markEnvPauseSent(ws: WebSocket, pausedAtMs: number): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) metadata.pauseSentForMs = pausedAtMs;
}

/** Record that `lastSeenAt` was persisted now (heartbeat-window throttle lives in the route). */
export function markEnvLastSeenPersisted(ws: WebSocket, at: Date): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) metadata.lastSeenPersistedAt = at;
}

export function verifyEnvConnectionFingerprint(ws: WebSocket, currentFingerprint: string): boolean {
  const metadata = connectionMetadata.get(ws);
  if (!metadata || !metadata.fingerprint) return false;
  return metadata.fingerprint === currentFingerprint;
}

/**
 * This replica's live reading of an env, in the DTO's vocabulary
 * (`deriveLocalEnvStatus`'s `liveConnection` input): `connecting` while the
 * hello is pending, `connected` once authorized, `null` when there is no open
 * socket here.
 */
export function readEnvLiveConnection(envId: string): 'connecting' | 'connected' | null {
  const ws = connections.get(envId);
  if (!ws || (ws.readyState !== 0 && ws.readyState !== 1)) return null;
  const metadata = connectionMetadata.get(ws);
  if (!metadata) return null;
  return metadata.state === 'authorized' ? 'connected' : 'connecting';
}

/**
 * Clean up stale connections that are closed, inactive, or have expired sessions
 * Prevents memory leaks and enforces session expiry security
 * Also revalidates sessions to detect revoked tokens
 */
async function cleanupStaleConnections(): Promise<void> {
  const now = Date.now();
  const nowDate = new Date();
  const staleConnections: Array<{ envId: string; ws: WebSocket; reason: string }> = [];

  for (const [envId, ws] of connections.entries()) {
    const metadata = connectionMetadata.get(ws);

    // Check if WebSocket is closed (readyState 2 = CLOSING, 3 = CLOSED)
    if (ws.readyState === 2 || ws.readyState === 3) {
      staleConnections.push({ envId, ws, reason: 'closed' });
      continue;
    }

    if (metadata) {
      // Check if session has expired (critical security check)
      if (metadata.sessionExpiresAt && nowDate > metadata.sessionExpiresAt) {
        wsLogger().warn('Closing env connection due to expired session', {
          envId,
          sessionId: metadata.sessionId,
          expiredAt: metadata.sessionExpiresAt.toISOString(),
          action: 'session_expired_cleanup',
        });
        staleConnections.push({ envId, ws, reason: 'session_expired' });
        continue;
      }

      // Check if connection has been inactive for too long
      const lastActivity = metadata.lastPing?.getTime() || metadata.connectedAt.getTime();
      const inactiveDuration = now - lastActivity;

      if (inactiveDuration > ENV_STALE_CONNECTION_TIMEOUT_MS) {
        wsLogger().warn('Env connection is stale due to inactivity', {
          envId,
          inactiveDurationMinutes: Math.round(inactiveDuration / 60000),
          action: 'stale_detected',
        });
        staleConnections.push({ envId, ws, reason: 'inactive' });
      }
    }
  }

  if (staleConnections.length > 0) {
    wsLogger().info('Cleaning up stale env connections', { staleCount: staleConnections.length, action: 'cleanup_start' });

    for (const { envId, ws, reason } of staleConnections) {
      if (ws.readyState === 0 || ws.readyState === 1) {
        try {
          const closeMessage = reason === 'session_expired' ? 'Session expired' : 'Connection cleanup - inactive';
          ws.close(1000, closeMessage);
        } catch (error) {
          wsLogger().warn('Error closing stale env connection', {
            envId,
            reason,
            error: error instanceof Error ? error.message : String(error),
            action: 'close_error',
          });
        }
      }
      // Through the CAS, so a socket that was already superseded fires no lost event.
      unregisterEnvConnection(envId, ws);
    }

    wsLogger().info('Env cleanup complete', { activeConnections: connections.size, removedCount: staleConnections.length, action: 'cleanup_complete' });
  }

  // Revalidate sessions to detect revoked tokens (P1 security fix)
  await revalidateSessions();
}

/**
 * Revalidate active sessions to detect revoked tokens
 * Closes connections where the `env:bridge` session has been revoked (revokedAt
 * set — e.g. by `revokeLocalEnv`), the user's tokenVersion changed, or the user
 * was suspended. Parallel validation, as in the desktop map.
 */
async function revalidateSessions(): Promise<void> {
  const now = Date.now();

  const connectionsToValidate: Array<{ envId: string; ws: WebSocket; metadata: EnvConnectionMetadata }> = [];

  for (const [envId, ws] of connections.entries()) {
    const metadata = connectionMetadata.get(ws);
    if (!metadata?.wsToken) continue;

    const lastRevalidated = metadata.lastRevalidated?.getTime() || 0;
    if (now - lastRevalidated < ENV_SESSION_REVALIDATION_INTERVAL_MS) continue;

    connectionsToValidate.push({ envId, ws, metadata });
  }

  if (connectionsToValidate.length === 0) return;

  const validationResults = await Promise.allSettled(
    connectionsToValidate.map(async ({ envId, ws, metadata }) => {
      const claims = await sessionService.validateSession(metadata.wsToken!, { expectedType: 'mcp' });
      return { envId, ws, metadata, claims };
    }),
  );

  const connectionsToClose: Array<{ envId: string; ws: WebSocket; reason: string }> = [];

  for (let i = 0; i < validationResults.length; i++) {
    const result = validationResults[i];
    const { envId, ws, metadata } = connectionsToValidate[i];

    if (result.status === 'fulfilled') {
      metadata.lastRevalidated = new Date();

      if (!result.value.claims) {
        wsLogger().warn('Env session revalidation failed', { envId, sessionId: metadata.sessionId, action: 'session_revoked' });
        connectionsToClose.push({ envId, ws, reason: 'session_revoked' });
      }
    } else {
      // Don't close on transient errors - will retry next interval
      wsLogger().error('Env session revalidation error', {
        envId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        action: 'revalidation_error',
      });
    }
  }

  for (const { envId, ws, reason } of connectionsToClose) {
    if (ws.readyState === 0 || ws.readyState === 1) {
      ws.close(1008, 'Session revoked');
    }
    unregisterEnvConnection(envId, ws);
    wsLogger().info('Closed env connection due to revoked session', { envId, reason, action: 'session_revoked_cleanup' });
  }
}

export function startEnvCleanupInterval(): void {
  if (cleanupInterval) {
    wsLogger().debug('Env cleanup interval already running', { action: 'start_cleanup_interval', status: 'already_running' });
    return;
  }
  cleanupInterval = setInterval(() => {
    cleanupStaleConnections().catch((err) =>
      wsLogger().error('Env cleanup error', { error: err instanceof Error ? err.message : String(err), action: 'cleanup_interval_error' }),
    );
  }, CLEANUP_INTERVAL_MS);
  wsLogger().info('Started env cleanup interval', { intervalMinutes: CLEANUP_INTERVAL_MS / 60000, action: 'start_cleanup_interval', status: 'started' });
}

function stopEnvCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    wsLogger().info('Stopped env cleanup interval', { action: 'stop_cleanup_interval', status: 'stopped' });
  }
}

/** Manually trigger cleanup (useful for testing) */
export async function triggerEnvCleanup(): Promise<void> {
  await cleanupStaleConnections();
}

export interface EnvConnectionHealthCheck {
  isHealthy: boolean;
  reason?: string;
  readyState: number;
  lastPing?: Date;
  connectedDuration: number;
  sessionExpired?: boolean;
}

/**
 * Health check before anything is sent to the daemon: registered, open,
 * authorized (signed hello verified), session not expired — the same four
 * checks as the desktop map's `checkConnectionHealth`, in the same order.
 */
export function checkEnvConnectionHealth(ws: WebSocket): EnvConnectionHealthCheck {
  const metadata = connectionMetadata.get(ws);

  if (!metadata) {
    return { isHealthy: false, reason: 'Connection not registered', readyState: ws.readyState, connectedDuration: 0 };
  }

  if (ws.readyState !== 1) {
    const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return {
      isHealthy: false,
      reason: `Connection not open (state: ${stateNames[ws.readyState] || 'UNKNOWN'})`,
      readyState: ws.readyState,
      lastPing: metadata.lastPing,
      connectedDuration: Date.now() - metadata.connectedAt.getTime(),
    };
  }

  if (metadata.state !== 'authorized') {
    return {
      isHealthy: false,
      reason: 'Authentication not completed',
      readyState: ws.readyState,
      lastPing: metadata.lastPing,
      connectedDuration: Date.now() - metadata.connectedAt.getTime(),
    };
  }

  if (metadata.sessionExpiresAt && new Date() > metadata.sessionExpiresAt) {
    wsLogger().warn('Session expired for env connection', {
      envId: metadata.envId,
      sessionId: metadata.sessionId,
      expiredAt: metadata.sessionExpiresAt.toISOString(),
      action: 'session_expired',
    });
    return {
      isHealthy: false,
      reason: 'Session expired',
      readyState: ws.readyState,
      lastPing: metadata.lastPing,
      connectedDuration: Date.now() - metadata.connectedAt.getTime(),
      sessionExpired: true,
    };
  }

  return { isHealthy: true, readyState: ws.readyState, lastPing: metadata.lastPing, connectedDuration: Date.now() - metadata.connectedAt.getTime() };
}

/** @internal testing only — clears connection STATE and stops the sweep; lost listeners are module wiring (the bridge client subscribes once) and stay. */
export function clearAllEnvConnectionsForTesting(): void {
  stopEnvCleanupInterval();
  connections.clear();
  connectionMetadata.clear();
}
