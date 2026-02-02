/**
 * WebSocket Connection Manager Tests
 * Tests for connection lifecycle, cleanup, and health checks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  updateLastPing,
  markChallengeVerified,
  isChallengeVerified,
  getConnectionMetadata,
  checkConnectionHealth,
  startCleanupInterval,
  stopCleanupInterval,
  triggerCleanup,
  getConnectionStats,
  clearAllConnectionsForTesting,
} from '../ws-connections';

// Mock logger and sessionService to prevent side effects during tests
vi.mock('@pagespace/lib', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
  sessionService: {
    // Mock validateSession to return null by default (session invalid)
    // Tests that don't pass wsToken to registerConnection will skip revalidation anyway
    validateSession: vi.fn().mockResolvedValue(null),
  },
}));

describe('WebSocket Connection Manager', () => {
  let mockClient: WebSocket;
  let mockClient2: WebSocket;

  beforeEach(() => {
    // Create mock WebSocket clients
    mockClient = {
      readyState: 1, // OPEN
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;

    mockClient2 = {
      readyState: 1, // OPEN
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;

    // Clean up any existing connections
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Stop any running cleanup intervals
    stopCleanupInterval();
    // Clear all connections to ensure test isolation
    clearAllConnectionsForTesting();
  });

  describe('registerConnection', () => {
    it('should register a new connection', () => {
      registerConnection('user_123', mockClient);
      const connection = getConnection('user_123');
      expect(connection).toBe(mockClient);
    });

    it('should register connection with fingerprint', () => {
      const fingerprint = 'test_fingerprint_hash';
      registerConnection('user_123', mockClient, fingerprint);

      const metadata = getConnectionMetadata(mockClient);
      expect(metadata).toBeDefined();
      expect(metadata?.fingerprint).toBe(fingerprint);
      expect(metadata?.userId).toBe('user_123');
      expect(metadata?.challengeVerified).toBe(false);
    });

    it('should close existing connection when user reconnects', () => {
      // Register first connection
      registerConnection('user_123', mockClient);

      // Register second connection (should close first)
      registerConnection('user_123', mockClient2);

      expect(mockClient.close).toHaveBeenCalledWith(1000, 'New connection established');
      expect(getConnection('user_123')).toBe(mockClient2);
    });

    it('should not close existing connection if already closed', () => {
      const closedClient = {
        readyState: 3, // CLOSED
        close: vi.fn(),
      } as unknown as WebSocket;

      registerConnection('user_123', closedClient);
      registerConnection('user_123', mockClient);

      expect(closedClient.close).not.toHaveBeenCalled();
    });

    it('should track connection timestamp', () => {
      const before = Date.now();
      registerConnection('user_123', mockClient);
      const after = Date.now();

      const metadata = getConnectionMetadata(mockClient);
      expect(metadata).toBeDefined();
      expect(metadata!.connectedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(metadata!.connectedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('unregisterConnection', () => {
    it('should unregister a connection', () => {
      registerConnection('user_123', mockClient);
      expect(getConnection('user_123')).toBe(mockClient);

      unregisterConnection('user_123', mockClient);
      expect(getConnection('user_123')).toBeUndefined();
    });

    it('should remove connection metadata', () => {
      registerConnection('user_123', mockClient);
      expect(getConnectionMetadata(mockClient)).toBeDefined();

      unregisterConnection('user_123', mockClient);
      expect(getConnectionMetadata(mockClient)).toBeUndefined();
    });

    it('should handle unregistering non-existent connection', () => {
      expect(() => {
        unregisterConnection('user_999', mockClient);
      }).not.toThrow();
    });

    it('should not remove new connection when old connection closes (race condition)', () => {
      // Register initial connection
      registerConnection('user_123', mockClient);
      expect(getConnection('user_123')).toBe(mockClient);

      // User reconnects with new connection
      // This closes mockClient and stores mockClient2
      registerConnection('user_123', mockClient2);
      expect(getConnection('user_123')).toBe(mockClient2);

      // Old connection's close handler fires (simulating race condition)
      // This should NOT remove mockClient2 from the connections map
      unregisterConnection('user_123', mockClient);

      // New connection should still be registered
      expect(getConnection('user_123')).toBe(mockClient2);

      // Old connection metadata should be cleaned up
      expect(getConnectionMetadata(mockClient)).toBeUndefined();

      // New connection metadata should still exist
      expect(getConnectionMetadata(mockClient2)).toBeDefined();
    });
  });

  describe('getConnection', () => {
    it('should return undefined for non-existent connection', () => {
      expect(getConnection('user_999')).toBeUndefined();
    });

    it('should return correct connection for user', () => {
      registerConnection('user_123', mockClient);
      registerConnection('user_456', mockClient2);

      expect(getConnection('user_123')).toBe(mockClient);
      expect(getConnection('user_456')).toBe(mockClient2);
    });
  });

  describe('updateLastPing', () => {
    it('should update last ping timestamp', async () => {
      registerConnection('user_123', mockClient);

      const metadata1 = getConnectionMetadata(mockClient);
      expect(metadata1?.lastPing).toBeUndefined();

      // Wait 10ms to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      updateLastPing(mockClient);

      const metadata2 = getConnectionMetadata(mockClient);
      expect(metadata2?.lastPing).toBeDefined();
      expect(metadata2!.lastPing!.getTime()).toBeGreaterThan(metadata1!.connectedAt.getTime());
    });

    it('should handle updating ping for non-existent connection', () => {
      expect(() => {
        updateLastPing(mockClient);
      }).not.toThrow();
    });
  });

  describe('Challenge Verification', () => {
    it('should mark connection as challenge verified', () => {
      registerConnection('user_123', mockClient);

      expect(isChallengeVerified(mockClient)).toBe(false);

      markChallengeVerified(mockClient);

      expect(isChallengeVerified(mockClient)).toBe(true);
    });

    it('should return false for non-existent connection', () => {
      expect(isChallengeVerified(mockClient)).toBe(false);
    });

    it('should persist verification after ping update', () => {
      registerConnection('user_123', mockClient);
      markChallengeVerified(mockClient);
      updateLastPing(mockClient);

      expect(isChallengeVerified(mockClient)).toBe(true);
    });
  });

  describe('Connection Health Checks', () => {
    it('should return healthy for open and verified connection', () => {
      registerConnection('user_123', mockClient);
      markChallengeVerified(mockClient);

      const health = checkConnectionHealth(mockClient);

      expect(health.isHealthy).toBe(true);
      expect(health.readyState).toBe(1);
    });

    it('should return unhealthy for closed connection', () => {
      const closedClient = {
        readyState: 3, // CLOSED
      } as unknown as WebSocket;

      registerConnection('user_123', closedClient);
      markChallengeVerified(closedClient);

      const health = checkConnectionHealth(closedClient);

      expect(health.isHealthy).toBe(false);
      expect(health.reason).toBe('Connection not open (state: CLOSED)');
      expect(health.readyState).toBe(3);
    });

    it('should return unhealthy for unverified connection', () => {
      registerConnection('user_123', mockClient);

      const health = checkConnectionHealth(mockClient);

      expect(health.isHealthy).toBe(false);
      expect(health.reason).toBe('Authentication not completed');
    });

    it('should return unhealthy for unregistered connection', () => {
      const health = checkConnectionHealth(mockClient);

      expect(health.isHealthy).toBe(false);
      expect(health.reason).toBe('Connection not registered');
    });

    it('should check all readyState values', () => {
      const states = [
        { state: 0, name: 'CONNECTING', healthy: false },
        { state: 1, name: 'OPEN', healthy: true },
        { state: 2, name: 'CLOSING', healthy: false },
        { state: 3, name: 'CLOSED', healthy: false },
      ];

      states.forEach(({ state, healthy }) => {
        const client = {
          readyState: state,
        } as unknown as WebSocket;

        registerConnection('user_test', client);
        markChallengeVerified(client);

        const health = checkConnectionHealth(client);
        expect(health.isHealthy).toBe(healthy);

        unregisterConnection('user_test', client);
      });
    });
  });

  describe('Connection Metadata', () => {
    it('should return complete metadata', () => {
      const fingerprint = 'test_fingerprint';
      registerConnection('user_123', mockClient, fingerprint);
      markChallengeVerified(mockClient);
      updateLastPing(mockClient);

      const metadata = getConnectionMetadata(mockClient);

      expect(metadata).toBeDefined();
      expect(metadata!.userId).toBe('user_123');
      expect(metadata!.fingerprint).toBe(fingerprint);
      expect(metadata!.challengeVerified).toBe(true);
      expect(metadata!.connectedAt).toBeInstanceOf(Date);
      expect(metadata!.lastPing).toBeInstanceOf(Date);
    });

    it('should return undefined for unregistered connection', () => {
      expect(getConnectionMetadata(mockClient)).toBeUndefined();
    });
  });

  describe('Connection Statistics', () => {
    it('should return correct connection count', () => {
      expect(getConnectionStats().totalConnections).toBe(0);

      registerConnection('user_1', mockClient);
      expect(getConnectionStats().totalConnections).toBe(1);

      registerConnection('user_2', mockClient2);
      expect(getConnectionStats().totalConnections).toBe(2);

      unregisterConnection('user_1', mockClient);
      expect(getConnectionStats().totalConnections).toBe(1);
    });

    it('should track metadata entries', () => {
      registerConnection('user_1', mockClient);
      registerConnection('user_2', mockClient2);

      expect(getConnectionStats().metadataEntries).toBe(2);

      unregisterConnection('user_1', mockClient);
      expect(getConnectionStats().metadataEntries).toBe(1);
    });

    it('should track oldest and newest connections', async () => {
      registerConnection('user_1', mockClient);

      const stats1 = getConnectionStats();
      expect(stats1.oldestConnection).toBeInstanceOf(Date);
      expect(stats1.newestConnection).toBeInstanceOf(Date);

      // Wait 10ms to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      registerConnection('user_2', mockClient2);

      const stats2 = getConnectionStats();
      expect(stats2.oldestConnection).toBeInstanceOf(Date);
      expect(stats2.newestConnection).toBeInstanceOf(Date);
      expect(stats2.newestConnection!.getTime()).toBeGreaterThan(stats2.oldestConnection!.getTime());
    });

    it('should return null for oldest/newest when no connections', () => {
      const stats = getConnectionStats();
      expect(stats.oldestConnection).toBeNull();
      expect(stats.newestConnection).toBeNull();
    });
  });

  describe('Cleanup Interval', () => {
    it('should start and stop cleanup interval', () => {
      startCleanupInterval();
      stopCleanupInterval();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should not start multiple intervals', () => {
      startCleanupInterval();
      startCleanupInterval(); // Should be no-op
      stopCleanupInterval();

      expect(true).toBe(true);
    });

    it('should handle stopping when not running', () => {
      stopCleanupInterval(); // Should be no-op
      expect(true).toBe(true);
    });
  });

  describe('Manual Cleanup', () => {
    it('should clean up closed connections', async () => {
      const closedClient = {
        readyState: 3, // CLOSED
        close: vi.fn(),
      } as unknown as WebSocket;

      registerConnection('user_1', closedClient);
      expect(getConnection('user_1')).toBe(closedClient);

      await triggerCleanup();

      expect(getConnection('user_1')).toBeUndefined();
    });

    it('should not clean up open connections', async () => {
      registerConnection('user_1', mockClient);
      markChallengeVerified(mockClient);
      updateLastPing(mockClient);

      await triggerCleanup();

      expect(getConnection('user_1')).toBe(mockClient);
    });

    it('should handle cleanup with no connections', async () => {
      await expect(triggerCleanup()).resolves.not.toThrow();
    });
  });

  describe('Multiple Users', () => {
    it('should handle multiple simultaneous connections', () => {
      const users = Array.from({ length: 10 }, (_, i) => `user_${i}`);
      const clients = Array.from({ length: 10 }, () => ({
        readyState: 1,
        close: vi.fn(),
      } as unknown as WebSocket));

      users.forEach((userId, i) => {
        registerConnection(userId, clients[i]);
      });

      expect(getConnectionStats().totalConnections).toBe(10);

      users.forEach((userId, i) => {
        expect(getConnection(userId)).toBe(clients[i]);
      });
    });

    it('should isolate connections between users', () => {
      registerConnection('user_1', mockClient);
      registerConnection('user_2', mockClient2);

      markChallengeVerified(mockClient);

      expect(isChallengeVerified(mockClient)).toBe(true);
      expect(isChallengeVerified(mockClient2)).toBe(false);
    });
  });

  describe('Session Revalidation', () => {
    it('should skip connections without wsToken', async () => {
      // Register without wsToken (6th parameter)
      registerConnection('user_1', mockClient, 'fingerprint', 'session_1');
      markChallengeVerified(mockClient);

      await triggerCleanup();

      // Connection should still exist (revalidation skipped)
      expect(getConnection('user_1')).toBe(mockClient);
    });

    it('should close connections with revoked sessions', async () => {
      // Import the mocked sessionService to configure the mock
      const { sessionService } = await import('@pagespace/lib');

      // Mock validateSession to return null (session revoked)
      vi.mocked(sessionService.validateSession).mockResolvedValueOnce(null);

      // Register with wsToken to trigger revalidation
      registerConnection('user_1', mockClient, 'fingerprint', 'session_1', undefined, 'test_token');
      markChallengeVerified(mockClient);

      await triggerCleanup();

      // Connection should be closed due to revoked session
      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Session revoked');
      expect(getConnection('user_1')).toBeUndefined();
    });

    it('should keep connections with valid sessions', async () => {
      const { sessionService } = await import('@pagespace/lib');

      // Mock validateSession to return valid claims
      vi.mocked(sessionService.validateSession).mockResolvedValueOnce({
        userId: 'user_1',
        sessionId: 'session_1',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'device',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 86400000),
      });

      registerConnection('user_1', mockClient, 'fingerprint', 'session_1', undefined, 'valid_token');
      markChallengeVerified(mockClient);

      await triggerCleanup();

      // Connection should still exist
      expect(getConnection('user_1')).toBe(mockClient);
      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it('should handle validation errors gracefully', async () => {
      const { sessionService } = await import('@pagespace/lib');

      // Mock validateSession to throw an error
      vi.mocked(sessionService.validateSession).mockRejectedValueOnce(new Error('Network error'));

      registerConnection('user_1', mockClient, 'fingerprint', 'session_1', undefined, 'test_token');
      markChallengeVerified(mockClient);

      await triggerCleanup();

      // Connection should remain open (don't close on transient errors)
      expect(getConnection('user_1')).toBe(mockClient);
      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it('should skip recently revalidated connections', async () => {
      const { sessionService } = await import('@pagespace/lib');

      // Mock validateSession to return valid claims
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        userId: 'user_1',
        sessionId: 'session_1',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'device',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Register with wsToken
      registerConnection('user_1', mockClient, 'fingerprint', 'session_1', undefined, 'test_token');
      markChallengeVerified(mockClient);

      // First cleanup - should trigger revalidation
      await triggerCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledTimes(1);

      // Second cleanup immediately after - should skip (recently revalidated)
      await triggerCleanup();
      expect(sessionService.validateSession).toHaveBeenCalledTimes(1); // Still 1, not 2

      // Connection should still exist
      expect(getConnection('user_1')).toBe(mockClient);
    });

    it('should validate multiple connections in parallel', async () => {
      const { sessionService } = await import('@pagespace/lib');

      // Mock validateSession with a delay to test parallelism
      vi.mocked(sessionService.validateSession).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          userId: 'user',
          sessionId: 'session',
          userRole: 'user',
          tokenVersion: 1,
          adminRoleVersion: 0,
          type: 'device',
          scopes: ['*'],
          expiresAt: new Date(Date.now() + 86400000),
        };
      });

      // Register multiple connections with wsTokens
      registerConnection('user_1', mockClient, 'fingerprint', 'session_1', undefined, 'token_1');
      registerConnection('user_2', mockClient2, 'fingerprint', 'session_2', undefined, 'token_2');
      markChallengeVerified(mockClient);
      markChallengeVerified(mockClient2);

      const startTime = Date.now();
      await triggerCleanup();
      const elapsed = Date.now() - startTime;

      // Both should be validated
      expect(sessionService.validateSession).toHaveBeenCalledTimes(2);

      // If serial, would take ~20ms. If parallel, ~10ms.
      // Allow some buffer for test environment variance
      expect(elapsed).toBeLessThan(50);

      // Both connections should still exist
      expect(getConnection('user_1')).toBe(mockClient);
      expect(getConnection('user_2')).toBe(mockClient2);
    });
  });
});
