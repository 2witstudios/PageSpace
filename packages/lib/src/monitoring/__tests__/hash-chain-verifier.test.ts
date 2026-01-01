/**
 * Hash Chain Verifier Tests
 *
 * Tests for hash chain integrity verification:
 * - Full chain verification
 * - Break point detection
 * - Quick integrity checks
 * - Entry-level verification
 *
 * @scaffold - characterizing verification behavior with ORM mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeLogHash, generateChainSeed } from '../activity-logger';

// Mock data storage
let mockLogEntries: Array<{
  id: string;
  timestamp: Date;
  userId: string;
  actorEmail: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  driveId: string | null;
  pageId: string | null;
  contentSnapshot: string | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  previousLogHash: string | null;
  logHash: string | null;
  chainSeed: string | null;
}> = [];

// Mock database
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      activityLogs: {
        findFirst: vi.fn().mockImplementation(async (opts) => {
          let entries = [...mockLogEntries];

          // Apply where clause
          if (opts?.where) {
            // Handle different where clause patterns
            if (typeof opts.where === 'function') {
              // Callback-style where clause
              const mockLogs = {
                id: 'id',
                logHash: 'logHash',
                chainSeed: 'chainSeed',
                timestamp: 'timestamp',
              };
              const mockOps = {
                eq: (field: string, value: string) => ({ type: 'eq', field, value }),
                isNotNull: (field: string) => ({ type: 'isNotNull', field }),
              };
              const condition = opts.where(mockLogs, mockOps);
              if (condition?.type === 'eq') {
                entries = entries.filter(e => e.id === condition.value);
              }
            }
          }

          // Apply orderBy
          if (opts?.orderBy) {
            entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          }

          // Apply columns selection
          if (opts?.columns && entries.length > 0) {
            const entry = entries[0];
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(opts.columns)) {
              if (key in entry) {
                result[key] = entry[key as keyof typeof entry];
              }
            }
            return result;
          }

          return entries[0] || null;
        }),
        findMany: vi.fn().mockImplementation(async (opts) => {
          let entries = [...mockLogEntries];

          // Apply orderBy
          if (opts?.orderBy) {
            entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          }

          // Apply offset
          if (opts?.offset) {
            entries = entries.slice(opts.offset);
          }

          // Apply limit
          if (opts?.limit) {
            entries = entries.slice(0, opts.limit);
          }

          // Apply columns selection
          if (opts?.columns) {
            return entries.map(entry => {
              const result: Record<string, unknown> = {};
              for (const key of Object.keys(opts.columns)) {
                if (key in entry) {
                  result[key] = entry[key as keyof typeof entry];
                }
              }
              return result;
            });
          }

          return entries;
        }),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          // Count with hash filter
          const withHash = mockLogEntries.filter(e => e.logHash !== null);
          return Promise.resolve([{ count: withHash.length }]);
        }),
      }),
    }),
  },
  activityLogs: {
    id: 'id',
    timestamp: 'timestamp',
    logHash: 'logHash',
    chainSeed: 'chainSeed',
    previousLogHash: 'previousLogHash',
  },
}));

// Import after mocking
import {
  verifyHashChain,
  quickIntegrityCheck,
  getHashChainStats,
  verifyEntry,
  type HashChainVerificationResult,
} from '../hash-chain-verifier';
import { db } from '@pagespace/db';

/**
 * Helper to create a valid hash chain of log entries
 */
function createValidHashChain(count: number): typeof mockLogEntries {
  const entries: typeof mockLogEntries = [];
  const chainSeed = generateChainSeed();
  let previousHash = chainSeed;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.now() + i * 1000);
    const id = `log-${i + 1}`;

    const entryData = {
      id,
      timestamp,
      userId: 'user-123',
      actorEmail: 'test@example.com',
      operation: 'create',
      resourceType: 'page',
      resourceId: `page-${i + 1}`,
      driveId: 'drive-1',
      pageId: null as string | null,
      contentSnapshot: null as string | null,
      previousValues: null as Record<string, unknown> | null,
      newValues: null as Record<string, unknown> | null,
      metadata: null as Record<string, unknown> | null,
    };

    const logHash = computeLogHash(entryData, previousHash);

    entries.push({
      ...entryData,
      previousLogHash: i === 0 ? null : entries[i - 1]?.logHash ?? null,
      logHash,
      chainSeed: i === 0 ? chainSeed : null,
    });

    previousHash = logHash;
  }

  return entries;
}

describe('hash-chain-verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogEntries = [];
  });

  describe('verifyHashChain', () => {
    it('should return valid for an empty chain', async () => {
      // Arrange - empty entries
      mockLogEntries = [];

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(0);
      expect(result.entriesVerified).toBe(0);
      expect(result.breakPoint).toBeNull();
    });

    it('should verify a valid hash chain successfully', async () => {
      // Arrange - create valid chain
      mockLogEntries = createValidHashChain(5);

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 5 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(5);
      expect(result.validEntries).toBe(5);
      expect(result.invalidEntries).toBe(0);
      expect(result.breakPoint).toBeNull();
      expect(result.chainSeed).not.toBeNull();
    });

    it('should detect tampering when hash is modified', async () => {
      // Arrange - create valid chain then tamper with an entry
      mockLogEntries = createValidHashChain(5);
      // Tamper with the 3rd entry's hash
      mockLogEntries[2]!.logHash = 'tampered-hash-value';

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 5 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.invalidEntries).toBeGreaterThan(0);
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.entryId).toBe('log-3');
      expect(result.breakPoint?.position).toBe(2);
      expect(result.breakPoint?.storedHash).toBe('tampered-hash-value');
    });

    it('should detect tampering when content is modified', async () => {
      // Arrange - create valid chain then modify content
      mockLogEntries = createValidHashChain(3);
      // Modify the userId of the 2nd entry (which changes its hash)
      mockLogEntries[1]!.userId = 'modified-user';

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 3 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.entryId).toBe('log-2');
      expect(result.breakPoint?.description).toContain('Hash mismatch');
    });

    it('should stop at first break point when stopOnFirstBreak is true', async () => {
      // Arrange - create chain with multiple tampered entries
      mockLogEntries = createValidHashChain(5);
      mockLogEntries[1]!.logHash = 'tampered-1';
      mockLogEntries[3]!.logHash = 'tampered-2';

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 5 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain({ stopOnFirstBreak: true });

      // Assert - should stop at first break
      expect(result.isValid).toBe(false);
      expect(result.breakPoint?.entryId).toBe('log-2');
      expect(result.entriesVerified).toBeLessThan(5);
    });

    it('should respect the limit option', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(10);

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 10 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain({ limit: 3 });

      // Assert
      expect(result.entriesVerified).toBe(3);
      expect(result.totalEntries).toBe(10);
    });

    it('should count entries without hash as legacy entries', async () => {
      // Arrange - mix of entries with and without hash
      mockLogEntries = createValidHashChain(3);
      // Add an entry without hash (legacy)
      mockLogEntries.push({
        id: 'legacy-1',
        timestamp: new Date(Date.now() + 10000),
        userId: 'user-123',
        actorEmail: 'test@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-legacy',
        driveId: 'drive-1',
        pageId: null,
        contentSnapshot: null,
        previousValues: null,
        newValues: null,
        metadata: null,
        previousLogHash: null,
        logHash: null, // No hash
        chainSeed: null,
      });

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 4 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.entriesWithoutHash).toBe(1);
      expect(result.validEntries).toBe(3);
    });

    it('should include timing information in result', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(2);

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 2 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.verificationStartedAt).toBeInstanceOf(Date);
      expect(result.verificationCompletedAt).toBeInstanceOf(Date);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.verificationCompletedAt.getTime()).toBeGreaterThanOrEqual(
        result.verificationStartedAt.getTime()
      );
    });
  });

  describe('quickIntegrityCheck', () => {
    it('should return valid for chain with seed and consistent hashes', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(5);

      // Act
      const result = await quickIntegrityCheck();

      // Assert
      expect(result.isLikelyValid).toBe(true);
      expect(result.hasChainSeed).toBe(true);
      expect(result.details).toContain('appears valid');
    });

    it('should detect missing chain seed', async () => {
      // Arrange - create chain without seed
      mockLogEntries = createValidHashChain(3);
      mockLogEntries[0]!.chainSeed = null;

      // Act
      const result = await quickIntegrityCheck();

      // Assert
      expect(result.hasChainSeed).toBe(false);
      expect(result.isLikelyValid).toBe(false);
      expect(result.details).toContain('Missing chain seed');
    });
  });

  describe('verifyEntry', () => {
    it('should verify a valid entry', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(3);

      // Act - verify the first entry
      const result = await verifyEntry('log-1');

      // Assert
      expect(result).not.toBeNull();
      expect(result?.isValid).toBe(true);
      expect(result?.id).toBe('log-1');
      expect(result?.storedHash).toBe(mockLogEntries[0]?.logHash);
      expect(result?.computedHash).toBe(mockLogEntries[0]?.logHash);
    });

    it('should return null for non-existent entry', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(2);

      // Act
      const result = await verifyEntry('non-existent-id');

      // Assert
      expect(result).toBeNull();
    });

    it('should detect invalid entry hash', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(2);
      const originalHash = mockLogEntries[0]!.logHash;
      mockLogEntries[0]!.logHash = 'tampered-hash';

      // Act
      const result = await verifyEntry('log-1');

      // Assert
      expect(result).not.toBeNull();
      expect(result?.isValid).toBe(false);
      expect(result?.storedHash).toBe('tampered-hash');
      expect(result?.computedHash).not.toBe('tampered-hash');
    });

    it('should use chain seed for first entry verification', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(2);
      const chainSeed = mockLogEntries[0]!.chainSeed!;

      // Act
      const result = await verifyEntry('log-1');

      // Assert
      expect(result?.previousHashUsed).toBe(chainSeed);
    });
  });

  describe('break point description', () => {
    it('should provide detailed break point information', async () => {
      // Arrange
      mockLogEntries = createValidHashChain(3);
      mockLogEntries[1]!.logHash = 'invalid-hash';

      // Mock count query
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 3 }]),
        }),
      } as never);

      // Act
      const result = await verifyHashChain();

      // Assert
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.description).toContain('Hash chain break detected');
      expect(result.breakPoint?.description).toContain('log-2');
      expect(result.breakPoint?.description).toContain('create on page');
      expect(result.breakPoint?.description).toContain('Hash mismatch');
    });
  });
});
