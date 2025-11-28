import type { WebSocket } from 'ws';
import { logger } from '@pagespace/lib';

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
  connectedAt: Date;
  lastPing?: Date;
  fingerprint?: string;
  challengeVerified: boolean;
  jwtExpiryTimer?: NodeJS.Timeout;
  jwtExpiresAt?: Date;
}

const connectionMetadata = new Map<WebSocket, ConnectionMetadata>();

// Stale connection cleanup configuration
const STALE_CONNECTION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
  fingerprint?: string
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
    connectedAt: new Date(),
    fingerprint,
    challengeVerified: false,
  });

  wsLogger.info('WebSocket connection registered', {
    userId,
    totalConnections: connections.size,
    action: 'register',
  });
}

/**
 * Unregister a WebSocket connection
 * Only removes the connection if it's still the active one (prevents race condition)
 */
export function unregisterConnection(userId: string, ws: WebSocket): void {
  // Clear JWT expiry timer before unregistering
  clearJWTExpiryTimer(ws);

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
 * Set JWT expiry timer for automatic disconnection
 * Schedules connection closure when JWT expires
 */
export function setJWTExpiryTimer(
  ws: WebSocket,
  expiresAt: Date,
  onExpiry?: () => void
): void {
  const metadata = connectionMetadata.get(ws);
  if (!metadata) {
    return;
  }

  // Clear existing timer if any
  if (metadata.jwtExpiryTimer) {
    clearTimeout(metadata.jwtExpiryTimer);
  }

  const now = Date.now();
  const expiresAtMs = expiresAt.getTime();
  const timeUntilExpiry = expiresAtMs - now;

  // Only set timer if expiry is in the future
  if (timeUntilExpiry > 0) {
    metadata.jwtExpiresAt = expiresAt;
    metadata.jwtExpiryTimer = setTimeout(() => {
      wsLogger.info('JWT expired, closing connection', {
        userId: metadata.userId,
        expiresAt: expiresAt.toISOString(),
        action: 'jwt_expiry',
      });

      // Execute callback if provided
      if (onExpiry) {
        onExpiry();
      }

      // Close connection with Session Expired message
      if (ws.readyState === 1) {
        // OPEN
        ws.close(1008, 'Session expired');
      }

      // Clean up metadata
      metadata.jwtExpiryTimer = undefined;
      metadata.jwtExpiresAt = undefined;
    }, timeUntilExpiry);
  } else {
    wsLogger.warn('JWT already expired', {
      userId: metadata.userId,
      expiresAt: expiresAt.toISOString(),
      action: 'jwt_already_expired',
    });
  }
}

/**
 * Clear JWT expiry timer (used on disconnect)
 */
export function clearJWTExpiryTimer(ws: WebSocket): void {
  const metadata = connectionMetadata.get(ws);
  if (metadata?.jwtExpiryTimer) {
    clearTimeout(metadata.jwtExpiryTimer);
    metadata.jwtExpiryTimer = undefined;
    metadata.jwtExpiresAt = undefined;
  }
}

/**
 * Check if connection has completed challenge verification
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
 * Clean up stale connections that are closed or inactive
 * Prevents memory leaks from connections that weren't properly unregistered
 */
function cleanupStaleConnections(): void {
  const now = Date.now();
  const staleConnections: Array<{ userId: string; ws: WebSocket }> = [];

  // Find closed or stale connections
  for (const [userId, ws] of connections.entries()) {
    const metadata = connectionMetadata.get(ws);

    // Check if WebSocket is closed (readyState 2 = CLOSING, 3 = CLOSED)
    if (ws.readyState === 2 || ws.readyState === 3) {
      staleConnections.push({ userId, ws });
      continue;
    }

    // Check if connection has been inactive for too long
    if (metadata) {
      const lastActivity = metadata.lastPing?.getTime() || metadata.connectedAt.getTime();
      const inactiveDuration = now - lastActivity;

      if (inactiveDuration > STALE_CONNECTION_TIMEOUT_MS) {
        wsLogger.warn('Connection is stale due to inactivity', {
          userId,
          inactiveDurationMinutes: Math.round(inactiveDuration / 60000),
          action: 'stale_detected',
        });
        staleConnections.push({ userId, ws });
      }
    }
  }

  // Remove stale connections
  if (staleConnections.length > 0) {
    wsLogger.info('Cleaning up stale connections', {
      staleCount: staleConnections.length,
      action: 'cleanup_start',
    });

    for (const { userId, ws } of staleConnections) {
      // Try to close if not already closed
      if (ws.readyState === 0 || ws.readyState === 1) {
        try {
          ws.close(1000, 'Connection cleanup - inactive');
        } catch (error) {
          wsLogger.warn('Error closing stale connection', {
            userId,
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

  cleanupInterval = setInterval(cleanupStaleConnections, CLEANUP_INTERVAL_MS);
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
export function triggerCleanup(): void {
  cleanupStaleConnections();
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
}

/**
 * Performs comprehensive health check on a WebSocket connection
 * Verifies connection is open, authenticated, and responsive
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

  // Check 3: Challenge verification completed
  if (!metadata.challengeVerified) {
    return {
      isHealthy: false,
      reason: 'Challenge verification not completed',
      readyState: ws.readyState,
      lastPing: metadata.lastPing,
      connectedDuration: Date.now() - metadata.connectedAt.getTime(),
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
