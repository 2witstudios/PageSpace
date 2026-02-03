import type { WebSocket } from 'ws';
import { logger, sessionService } from '@pagespace/lib';

/**
 * WebSocket Connection Manager
 *
 * Manages active WebSocket connections for the MCP bridge.
 * This is separated from the route handler to avoid Next.js route export restrictions.
 */

// Store active WebSocket connections by userId
const connections = new Map<string, WebSocket>();

// Track connection metadata
interface ConnectionMetadata {
  userId: string;
  sessionId?: string; // From session service
  sessionExpiresAt?: Date; // When the session token expires - connection should be closed after this
  connectedAt: Date;
  lastPing?: Date;
  fingerprint?: string;
  challengeVerified: boolean; // True once authenticated (immediately for opaque tokens)
  wsToken?: string; // Token for periodic revalidation (detects revoked sessions)
  lastRevalidated?: Date; // Track when we last validated the session
}

const connectionMetadata = new Map<WebSocket, ConnectionMetadata>();

// Stale connection cleanup configuration
const STALE_CONNECTION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - revalidate sessions to detect revoked tokens

/**
 * Cleanup interval for removing stale connections
 * Prevents memory leaks from connections that weren't properly unregistered
 */
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Logger for WebSocket connection management
 */
const wsLogger = logger.child({ component: 'ws-connections' });

/**
 * Register a new WebSocket connection for a user
 */
export function registerConnection(
  userId: string,
  ws: WebSocket,
  fingerprint?: string,
  sessionId?: string,
  sessionExpiresAt?: Date,
  wsToken?: string
): void {
  // Close existing connection if any
  const existingConnection = connections.get(userId);
  if (existingConnection && existingConnection.readyState === 1) {
    // OPEN
    wsLogger.info('Closing existing connection for new connection', {
      userId,
      action: 'close_existing',
    });
    existingConnection.close(1000, 'New connection established');
    connectionMetadata.delete(existingConnection);
  }

  connections.set(userId, ws);
  connectionMetadata.set(ws, {
    userId,
    sessionId,
    sessionExpiresAt,
    connectedAt: new Date(),
    fingerprint,
    challengeVerified: false,
    wsToken,
  });

  wsLogger.info('WebSocket connection registered', {
    userId,
    sessionId,
    sessionExpiresAt: sessionExpiresAt?.toISOString(),
    totalConnections: connections.size,
    action: 'register',
  });
}

/**
 * Unregister a WebSocket connection
 * Only removes the connection if it's still the active one (prevents race condition)
 */
export function unregisterConnection(userId: string, ws: WebSocket): void {
  // Only remove if this is still the active connection
  // Prevents race condition when old connection closes after new one registered
  const currentConnection = connections.get(userId);
  if (currentConnection === ws) {
    connections.delete(userId);
    wsLogger.info('WebSocket connection unregistered', {
      userId,
      totalConnections: connections.size,
      action: 'unregister',
    });
  } else {
    wsLogger.debug('Skipped unregistering stale connection', {
      userId,
      action: 'unregister_skipped',
      reason: 'not_active_connection',
    });
  }

  // Always clean up metadata for this specific WebSocket
  connectionMetadata.delete(ws);
}

/**
 * Get an active WebSocket connection for a user
 */
export function getConnection(userId: string): WebSocket | undefined {
  return connections.get(userId);
}

/**
 * Get all active connections
 */
export function getAllConnections(): Map<string, WebSocket> {
  return connections;
}

/**
 * Update last ping time for a connection
 */
export function updateLastPing(ws: WebSocket): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) {
    metadata.lastPing = new Date();
  }
}

/**
 * Get connection metadata
 */
export function getConnectionMetadata(
  ws: WebSocket
): ConnectionMetadata | undefined {
  return connectionMetadata.get(ws);
}

/**
 * Mark connection as challenge-verified
 */
export function markChallengeVerified(ws: WebSocket): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata) {
    metadata.challengeVerified = true;
  }
}

/**
 * Check if connection has completed challenge verification
 * With opaque token auth, this is set to true immediately after session validation
 */
export function isChallengeVerified(ws: WebSocket): boolean {
  const metadata = connectionMetadata.get(ws);
  return metadata?.challengeVerified ?? false;
}

/**
 * Verify connection fingerprint matches
 */
export function verifyConnectionFingerprint(
  ws: WebSocket,
  currentFingerprint: string
): boolean {
  const metadata = connectionMetadata.get(ws);
  if (!metadata || !metadata.fingerprint) {
    return false;
  }

  return metadata.fingerprint === currentFingerprint;
}

/**
 * Clean up stale connections that are closed, inactive, or have expired sessions
 * Prevents memory leaks and enforces session expiry security
 * Also revalidates sessions to detect revoked tokens
 */
async function cleanupStaleConnections(): Promise<void> {
  const now = Date.now();
  const nowDate = new Date();
  const staleConnections: Array<{ userId: string; ws: WebSocket; reason: string }> = [];

  // Find closed, stale, or expired connections
  for (const [userId, ws] of connections.entries()) {
    const metadata = connectionMetadata.get(ws);

    // Check if WebSocket is closed (readyState 2 = CLOSING, 3 = CLOSED)
    if (ws.readyState === 2 || ws.readyState === 3) {
      staleConnections.push({ userId, ws, reason: 'closed' });
      continue;
    }

    if (metadata) {
      // Check if session has expired (critical security check)
      if (metadata.sessionExpiresAt && nowDate > metadata.sessionExpiresAt) {
        wsLogger.warn('Closing connection due to expired session', {
          userId,
          sessionId: metadata.sessionId,
          expiredAt: metadata.sessionExpiresAt.toISOString(),
          action: 'session_expired_cleanup',
        });
        staleConnections.push({ userId, ws, reason: 'session_expired' });
        continue;
      }

      // Check if connection has been inactive for too long
      const lastActivity = metadata.lastPing?.getTime() || metadata.connectedAt.getTime();
      const inactiveDuration = now - lastActivity;

      if (inactiveDuration > STALE_CONNECTION_TIMEOUT_MS) {
        wsLogger.warn('Connection is stale due to inactivity', {
          userId,
          inactiveDurationMinutes: Math.round(inactiveDuration / 60000),
          action: 'stale_detected',
        });
        staleConnections.push({ userId, ws, reason: 'inactive' });
      }
    }
  }

  // Remove stale connections
  if (staleConnections.length > 0) {
    wsLogger.info('Cleaning up stale connections', {
      staleCount: staleConnections.length,
      action: 'cleanup_start',
    });

    for (const { userId, ws, reason } of staleConnections) {
      // Try to close if not already closed
      if (ws.readyState === 0 || ws.readyState === 1) {
        try {
          // Use appropriate close message based on reason
          const closeMessage = reason === 'session_expired'
            ? 'Session expired'
            : 'Connection cleanup - inactive';
          ws.close(1000, closeMessage);
        } catch (error) {
          wsLogger.warn('Error closing stale connection', {
            userId,
            reason,
            error: error instanceof Error ? error.message : String(error),
            action: 'close_error',
          });
        }
      }

      // Remove from maps
      connections.delete(userId);
      connectionMetadata.delete(ws);
    }

    wsLogger.info('Cleanup complete', {
      activeConnections: connections.size,
      removedCount: staleConnections.length,
      action: 'cleanup_complete',
    });
  }

  // Revalidate sessions to detect revoked tokens (P1 security fix)
  await revalidateSessions();
}

/**
 * Revalidate active sessions to detect revoked tokens
 * Closes connections where:
 * - Session has been revoked (revokedAt set)
 * - User's tokenVersion changed (password change)
 * - User was suspended
 *
 * Uses parallel validation for scale - all connections are validated concurrently
 * to minimize total validation time when many connections exist.
 *
 * This closes the security gap where 90-day tokens could persist after revocation.
 */
async function revalidateSessions(): Promise<void> {
  const now = Date.now();

  // Collect connections that need revalidation
  const connectionsToValidate: Array<{
    userId: string;
    ws: WebSocket;
    metadata: ConnectionMetadata;
  }> = [];

  for (const [userId, ws] of connections.entries()) {
    const metadata = connectionMetadata.get(ws);
    if (!metadata?.wsToken) continue;

    // Skip if recently revalidated
    const lastRevalidated = metadata.lastRevalidated?.getTime() || 0;
    if (now - lastRevalidated < SESSION_REVALIDATION_INTERVAL_MS) continue;

    connectionsToValidate.push({ userId, ws, metadata });
  }

  if (connectionsToValidate.length === 0) return;

  // Validate all sessions in parallel for scale
  const validationResults = await Promise.allSettled(
    connectionsToValidate.map(async ({ userId, ws, metadata }) => {
      const claims = await sessionService.validateSession(metadata.wsToken!);
      return { userId, ws, metadata, claims };
    })
  );

  const connectionsToClose: Array<{ userId: string; ws: WebSocket; reason: string }> = [];

  // Process results
  for (let i = 0; i < validationResults.length; i++) {
    const result = validationResults[i];
    const { userId, ws, metadata } = connectionsToValidate[i];

    if (result.status === 'fulfilled') {
      metadata.lastRevalidated = new Date();

      if (!result.value.claims) {
        wsLogger.warn('Session revalidation failed', {
          userId,
          sessionId: metadata.sessionId,
          action: 'session_revoked',
        });
        connectionsToClose.push({ userId, ws, reason: 'session_revoked' });
      }
    } else {
      // Don't close on transient errors - will retry next interval
      wsLogger.error('Session revalidation error', {
        userId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        action: 'revalidation_error',
      });
    }
  }

  // Close revoked connections
  for (const { userId, ws, reason } of connectionsToClose) {
    if (ws.readyState === 0 || ws.readyState === 1) {
      ws.close(1008, 'Session revoked');
    }
    connections.delete(userId);
    connectionMetadata.delete(ws);

    wsLogger.info('Closed connection due to revoked session', {
      userId,
      reason,
      action: 'session_revoked_cleanup',
    });
  }
}

/**
 * Start the automatic cleanup interval
 * Should be called when the server starts
 */
export function startCleanupInterval(): void {
  if (cleanupInterval) {
    wsLogger.debug('Cleanup interval already running', {
      action: 'start_cleanup_interval',
      status: 'already_running',
    });
    return;
  }

  cleanupInterval = setInterval(() => {
    cleanupStaleConnections().catch(err =>
      wsLogger.error('Cleanup error', {
        error: err instanceof Error ? err.message : String(err),
        action: 'cleanup_interval_error',
      })
    );
  }, CLEANUP_INTERVAL_MS);
  wsLogger.info('Started cleanup interval', {
    intervalMinutes: CLEANUP_INTERVAL_MS / 60000,
    action: 'start_cleanup_interval',
    status: 'started',
  });
}

/**
 * Stop the automatic cleanup interval
 * Should be called when the server shuts down
 */
export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    wsLogger.info('Stopped cleanup interval', {
      action: 'stop_cleanup_interval',
      status: 'stopped',
    });
  }
}

/**
 * Manually trigger cleanup (useful for testing)
 */
export async function triggerCleanup(): Promise<void> {
  await cleanupStaleConnections();
}

/**
 * Get connection statistics (for monitoring/debugging)
 */
export function getConnectionStats(): {
  totalConnections: number;
  metadataEntries: number;
  oldestConnection: Date | null;
  newestConnection: Date | null;
} {
  let oldestConnection: Date | null = null;
  let newestConnection: Date | null = null;

  for (const metadata of connectionMetadata.values()) {
    const connectedAt = metadata.connectedAt;

    if (!oldestConnection || connectedAt < oldestConnection) {
      oldestConnection = connectedAt;
    }
    if (!newestConnection || connectedAt > newestConnection) {
      newestConnection = connectedAt;
    }
  }

  return {
    totalConnections: connections.size,
    metadataEntries: connectionMetadata.size,
    oldestConnection,
    newestConnection,
  };
}

/**
 * Connection Health Check Result
 */
export interface ConnectionHealthCheck {
  isHealthy: boolean;
  reason?: string;
  readyState: number;
  lastPing?: Date;
  connectedDuration: number;
  sessionExpired?: boolean;
}

/**
 * Performs comprehensive health check on a WebSocket connection
 * Verifies connection is open, authenticated, session not expired, and responsive
 * Should be called before executing expensive operations like tool execution
 *
 * @param ws - WebSocket connection to check
 * @returns Health check result with details
 */
export function checkConnectionHealth(ws: WebSocket): ConnectionHealthCheck {
  const metadata = connectionMetadata.get(ws);

  // Check 1: Metadata exists (connection is registered)
  if (!metadata) {
    return {
      isHealthy: false,
      reason: 'Connection not registered',
      readyState: ws.readyState,
      connectedDuration: 0,
    };
  }

  // Check 2: WebSocket is OPEN (readyState 1)
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

  // Check 3: Authentication verified (set immediately after session validation)
  if (!metadata.challengeVerified) {
    return {
      isHealthy: false,
      reason: 'Authentication not completed',
      readyState: ws.readyState,
      lastPing: metadata.lastPing,
      connectedDuration: Date.now() - metadata.connectedAt.getTime(),
    };
  }

  // Check 4: Session not expired (critical for security - prevents indefinite access)
  if (metadata.sessionExpiresAt && new Date() > metadata.sessionExpiresAt) {
    wsLogger.warn('Session expired for WebSocket connection', {
      userId: metadata.userId,
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

  const connectedDuration = Date.now() - metadata.connectedAt.getTime();

  // All checks passed
  return {
    isHealthy: true,
    readyState: ws.readyState,
    lastPing: metadata.lastPing,
    connectedDuration,
  };
}

/**
 * Checks if connection is healthy and can execute tools
 * Throws an error with descriptive message if unhealthy
 *
 * @param ws - WebSocket connection to check
 * @throws Error if connection is unhealthy
 */
export function assertConnectionHealthy(ws: WebSocket): void {
  const health = checkConnectionHealth(ws);

  if (!health.isHealthy) {
    throw new Error(`Connection health check failed: ${health.reason}`);
  }
}

/**
 * Get user ID for a WebSocket connection
 * Returns undefined if connection not registered
 */
export function getUserIdForConnection(ws: WebSocket): string | undefined {
  const metadata = connectionMetadata.get(ws);
  return metadata?.userId;
}

/**
 * Clear all connections (for testing purposes only)
 * @internal
 */
export function clearAllConnectionsForTesting(): void {
  connections.clear();
  connectionMetadata.clear();
}
