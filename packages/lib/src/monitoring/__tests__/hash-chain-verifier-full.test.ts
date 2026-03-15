/**
 * Comprehensive tests for hash-chain-verifier.ts
 *
 * Covers:
 *  - verifyHashChain: empty, valid, broken, with limit, with timestamps, error path
 *  - quickIntegrityCheck: valid, invalid, error
 *  - getHashChainStats: with entries, without entries, error
 *  - verifyEntry: found valid, found invalid, not found, with chainSeed,
 *                 with previousLogHash, neither, error
 *
 * @scaffold - ORM chain mocks required for db.select().from().where() and
 * db.query.activityLogs.findFirst/findMany patterns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeLogHash, generateChainSeed } from '../activity-logger';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockFindMany = vi.hoisted(() => vi.fn());

// ── Mock @pagespace/db ─────────────────────────────────────────────────────────
vi.mock('@pagespace/db', () => ({
  db: {
    select: mockDbSelect,
    query: {
      activityLogs: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
    },
  },
  activityLogs: {
    id: 'id',
    timestamp: 'timestamp',
    logHash: 'logHash',
    chainSeed: 'chainSeed',
    previousLogHash: 'previousLogHash',
  },
  asc: vi.fn((col) => ({ dir: 'asc', col })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  count: vi.fn(() => 'count(*)'),
  and: vi.fn((...conds) => ({ type: 'and', conds })),
  gte: vi.fn((col, val) => ({ type: 'gte', col, val })),
  lte: vi.fn((col, val) => ({ type: 'lte', col, val })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import {
  verifyHashChain,
  quickIntegrityCheck,
  getHashChainStats,
  verifyEntry,
} from '../hash-chain-verifier';

// ── Type for mock entries ─────────────────────────────────────────────────────
type MockEntry = {
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
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildValidChain(count: number): MockEntry[] {
  const entries: MockEntry[] = [];
  const seed = generateChainSeed();
  let prevHash: string = seed;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(1_700_000_000_000 + i * 1000);
    const id = `entry-${i}`;
    const entryData = {
      id,
      timestamp,
      userId: 'u1',
      actorEmail: 'test@example.com',
      operation: 'create',
      resourceType: 'page',
      resourceId: `page-${i}`,
      driveId: 'drive-1',
    };
    const logHash = computeLogHash(entryData, prevHash);

    entries.push({
      ...entryData,
      pageId: null,
      contentSnapshot: null,
      previousValues: null,
      newValues: null,
      metadata: null,
      previousLogHash: i === 0 ? null : (entries[i - 1]?.logHash ?? null),
      logHash,
      chainSeed: i === 0 ? seed : null,
    });

    prevHash = logHash;
  }
  return entries;
}

/**
 * @scaffold - Sets up db.select().from().where() for count query and
 * db.query.activityLogs.findMany for paged batch retrieval.
 */
function setupDbMocks(entries: MockEntry[]) {
  // Count query: db.select({count}).from(activityLogs).where(...)
  // Source uses: db.select({ count: count() }).from(activityLogs).where(...)
  // The .where() result is awaited.
  const whereFn = vi.fn().mockResolvedValue([{ count: entries.length }]);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDbSelect.mockReturnValue({ from: fromFn });

  // findMany (batched paging)
  mockFindMany.mockImplementation(async (opts: Record<string, unknown> = {}) => {
    let result = [...entries];
    // Sort ascending by timestamp (mirrors the DB orderBy)
    result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    // Apply offset
    if (typeof opts.offset === 'number') result = result.slice(opts.offset);
    // Apply limit
    if (typeof opts.limit === 'number') result = result.slice(0, opts.limit);
    // Apply columns projection if specified
    if (opts.columns && typeof opts.columns === 'object') {
      const cols = opts.columns as Record<string, boolean>;
      return result.map(entry => {
        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(cols)) {
          projected[key] = entry[key as keyof MockEntry];
        }
        return projected;
      });
    }
    return result;
  });
}

describe('hash-chain-verifier (full coverage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── verifyHashChain ──────────────────────────────────────────────────────────
  describe('verifyHashChain', () => {
    it('should return isValid=true for an empty chain', async () => {
      setupDbMocks([]);
      const result = await verifyHashChain();
      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(0);
      expect(result.entriesVerified).toBe(0);
      expect(result.breakPoint).toBeNull();
      expect(result.chainSeed).toBeNull();
      expect(result.firstEntryId).toBeNull();
      expect(result.lastEntryId).toBeNull();
    });

    it('should verify a valid chain successfully', async () => {
      const chain = buildValidChain(4);
      setupDbMocks(chain);

      const result = await verifyHashChain();

      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(4);
      expect(result.entriesVerified).toBe(4);
      expect(result.validEntries).toBe(4);
      expect(result.invalidEntries).toBe(0);
      expect(result.entriesWithoutHash).toBe(0);
      expect(result.breakPoint).toBeNull();
      expect(result.chainSeed).not.toBeNull();
      expect(result.firstEntryId).toBe('entry-0');
      expect(result.lastEntryId).toBe('entry-3');
    });

    it('should detect tampering at position 1 (hash mismatch)', async () => {
      const chain = buildValidChain(3);
      chain[1]!.logHash = 'tampered-00000000000000000000000000000000000000000000';
      setupDbMocks(chain);

      const result = await verifyHashChain({ stopOnFirstBreak: true });

      expect(result.isValid).toBe(false);
      expect(result.invalidEntries).toBeGreaterThan(0);
      expect(result.breakPoint).not.toBeNull();
      expect(result.breakPoint?.entryId).toBe('entry-1');
      expect(result.breakPoint?.position).toBe(1);
    });

    it('should detect tampering via content modification', async () => {
      const chain = buildValidChain(3);
      chain[1]!.userId = 'modified-user'; // hash stays same but content differs
      setupDbMocks(chain);

      const result = await verifyHashChain();

      expect(result.isValid).toBe(false);
      expect(result.breakPoint?.entryId).toBe('entry-1');
      expect(result.breakPoint?.description).toContain('Hash mismatch');
    });

    it('should count entries without logHash as entriesWithoutHash', async () => {
      const chain = buildValidChain(2);
      const legacy: MockEntry = {
        id: 'legacy',
        timestamp: new Date(1_700_000_000_000 + 10_000),
        userId: 'u1',
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
        logHash: null,
        chainSeed: null,
      };
      const entries = [...chain, legacy];
      setupDbMocks(entries);

      const result = await verifyHashChain();

      expect(result.entriesWithoutHash).toBe(1);
      expect(result.validEntries).toBe(2);
    });

    it('should respect the limit option', async () => {
      const chain = buildValidChain(10);
      setupDbMocks(chain);

      const result = await verifyHashChain({ limit: 3 });

      expect(result.totalEntries).toBe(10);
      expect(result.entriesVerified).toBe(3);
    });

    it('should include timing fields in the result', async () => {
      setupDbMocks([]);
      const result = await verifyHashChain();

      expect(result.verificationStartedAt).toBeInstanceOf(Date);
      expect(result.verificationCompletedAt).toBeInstanceOf(Date);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should continue past first break when stopOnFirstBreak=false', async () => {
      const chain = buildValidChain(5);
      chain[1]!.logHash = 'bad-hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      chain[3]!.logHash = 'bad-hash-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      setupDbMocks(chain);

      const result = await verifyHashChain({ stopOnFirstBreak: false });

      expect(result.invalidEntries).toBeGreaterThanOrEqual(2);
    });

    it('should accept fromTimestamp and toTimestamp options without error', async () => {
      setupDbMocks([]);
      const result = await verifyHashChain({
        fromTimestamp: new Date('2024-01-01'),
        toTimestamp: new Date('2024-12-31'),
      });
      expect(result.isValid).toBe(true);
    });

    it('should throw when the DB itself throws', async () => {
      mockDbSelect.mockImplementation(() => {
        throw new Error('catastrophic DB failure');
      });

      await expect(verifyHashChain()).rejects.toThrow('catastrophic DB failure');
    });

    it('should handle batchSize option correctly', async () => {
      const chain = buildValidChain(6);
      setupDbMocks(chain);

      const result = await verifyHashChain({ batchSize: 2 });

      expect(result.isValid).toBe(true);
      expect(result.entriesVerified).toBe(6);
    });
  });

  // ── quickIntegrityCheck ──────────────────────────────────────────────────────
  describe('quickIntegrityCheck', () => {
    it('should return isLikelyValid=true for a valid chain', async () => {
      const chain = buildValidChain(5);

      // first entry query (for chain seed)
      mockFindFirst.mockResolvedValueOnce({
        id: chain[0]!.id,
        chainSeed: chain[0]!.chainSeed,
        logHash: chain[0]!.logHash,
      });

      // last entries query
      mockFindMany.mockResolvedValueOnce(
        chain.map(e => ({ id: e.id, logHash: e.logHash, previousLogHash: e.previousLogHash }))
      );

      const result = await quickIntegrityCheck();

      expect(result.hasChainSeed).toBe(true);
      expect(result.lastEntriesValid).toBe(true);
      expect(result.sampleValid).toBe(true);
      expect(result.isLikelyValid).toBe(true);
      expect(result.details).toContain('appears valid');
    });

    it('should detect missing chain seed', async () => {
      const chain = buildValidChain(3);

      mockFindFirst.mockResolvedValueOnce({
        id: chain[0]!.id,
        chainSeed: null,
        logHash: chain[0]!.logHash,
      });

      mockFindMany.mockResolvedValueOnce(
        chain.map(e => ({ id: e.id, logHash: e.logHash, previousLogHash: e.previousLogHash }))
      );

      const result = await quickIntegrityCheck();

      expect(result.hasChainSeed).toBe(false);
      expect(result.isLikelyValid).toBe(false);
      expect(result.details).toContain('Missing chain seed');
    });

    it('should detect inconsistent hash references in last entries', async () => {
      const chain = buildValidChain(3);

      mockFindFirst.mockResolvedValueOnce({
        id: chain[0]!.id,
        chainSeed: chain[0]!.chainSeed,
        logHash: chain[0]!.logHash,
      });

      // Make entry[1].previousLogHash inconsistent with entry[0].logHash
      const lastEntries = [
        { id: chain[0]!.id, logHash: chain[0]!.logHash, previousLogHash: null },
        { id: chain[1]!.id, logHash: chain[1]!.logHash, previousLogHash: 'wrong-hash' },
      ];
      mockFindMany.mockResolvedValueOnce(lastEntries);

      const result = await quickIntegrityCheck();

      expect(result.lastEntriesValid).toBe(false);
      expect(result.isLikelyValid).toBe(false);
      expect(result.details).toContain('Last entries have inconsistent hashes');
    });

    it('should return isLikelyValid=false on error', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('db fail'));

      const result = await quickIntegrityCheck();

      expect(result.isLikelyValid).toBe(false);
      expect(result.hasChainSeed).toBe(false);
      expect(result.details).toContain('Verification failed');
    });

    it('should handle first entry being null (no entries)', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockFindMany.mockResolvedValueOnce([]);

      const result = await quickIntegrityCheck();

      expect(result.hasChainSeed).toBe(false);
      // No last entries so lastEntriesValid stays true (empty loop)
      expect(result.lastEntriesValid).toBe(true);
    });
  });

  // ── getHashChainStats ────────────────────────────────────────────────────────
  describe('getHashChainStats', () => {
    it('should return correct stats when entries exist', async () => {
      const chain = buildValidChain(5);
      const firstTs = chain[0]!.timestamp;
      const lastTs = chain[chain.length - 1]!.timestamp;

      // @scaffold - db.select() is called twice: once for total count, once for with-hash count
      let selectCallCount = 0;
      mockDbSelect.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Total count: await db.select().from() (no .where() call in getHashChainStats for total)
          const fromFn = vi.fn().mockImplementation(() =>
            Promise.resolve([{ count: 5 }])
          );
          return { from: fromFn };
        } else {
          // With-hash count: .from().where(isNotNull)
          const fromFn = vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 4 }]),
          });
          return { from: fromFn };
        }
      });

      // findFirst: first call is for chain seed entry, second is for last entry
      mockFindFirst
        .mockResolvedValueOnce({ timestamp: firstTs, chainSeed: chain[0]!.chainSeed })
        .mockResolvedValueOnce({ timestamp: lastTs });

      const stats = await getHashChainStats();

      expect(stats.totalEntries).toBe(5);
      expect(stats.entriesWithHash).toBe(4);
      expect(stats.entriesWithoutHash).toBe(1);
      expect(stats.hasChainSeed).toBe(true);
      expect(stats.firstEntryTimestamp).toEqual(firstTs);
      expect(stats.lastEntryTimestamp).toEqual(lastTs);
    });

    it('should return hasChainSeed=false when no chain seed entry found', async () => {
      // @scaffold - Both count queries return 0: first awaits from() directly, second uses .where()
      let selectCallCount = 0;
      mockDbSelect.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const fromFn = vi.fn().mockImplementation(() =>
            Promise.resolve([{ count: 0 }])
          );
          return { from: fromFn };
        } else {
          const fromFn = vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          });
          return { from: fromFn };
        }
      });

      // findFirst returns null for both calls (chain seed and last entry)
      mockFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const stats = await getHashChainStats();

      expect(stats.hasChainSeed).toBe(false);
      expect(stats.firstEntryTimestamp).toBeNull();
      expect(stats.lastEntryTimestamp).toBeNull();
    });

    it('should throw on DB error', async () => {
      mockDbSelect.mockImplementation(() => {
        throw new Error('stats db error');
      });

      await expect(getHashChainStats()).rejects.toThrow('stats db error');
    });
  });

  // ── verifyEntry ──────────────────────────────────────────────────────────────
  describe('verifyEntry', () => {
    it('should return null when entry is not found', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const result = await verifyEntry('nonexistent');

      expect(result).toBeNull();
    });

    it('should verify a valid first entry using chainSeed', async () => {
      const chain = buildValidChain(1);
      const entry = chain[0]!;

      mockFindFirst.mockResolvedValueOnce({
        id: entry.id,
        timestamp: entry.timestamp,
        userId: entry.userId,
        actorEmail: entry.actorEmail,
        operation: entry.operation,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        driveId: entry.driveId,
        pageId: null,
        contentSnapshot: null,
        previousValues: null,
        newValues: null,
        metadata: null,
        previousLogHash: null,
        logHash: entry.logHash,
        chainSeed: entry.chainSeed,
      });

      const result = await verifyEntry(entry.id);

      expect(result).not.toBeNull();
      expect(result?.isValid).toBe(true);
      expect(result?.id).toBe(entry.id);
      expect(result?.storedHash).toBe(entry.logHash);
      expect(result?.previousHashUsed).toBe(entry.chainSeed);
    });

    it('should verify a subsequent entry using previousLogHash', async () => {
      const chain = buildValidChain(3);
      const entry = chain[2]!;

      mockFindFirst.mockResolvedValueOnce({
        id: entry.id,
        timestamp: entry.timestamp,
        userId: entry.userId,
        actorEmail: entry.actorEmail,
        operation: entry.operation,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        driveId: entry.driveId,
        pageId: null,
        contentSnapshot: null,
        previousValues: null,
        newValues: null,
        metadata: null,
        previousLogHash: entry.previousLogHash,
        logHash: entry.logHash,
        chainSeed: null,
      });

      const result = await verifyEntry(entry.id);

      expect(result?.isValid).toBe(true);
      expect(result?.previousHashUsed).toBe(entry.previousLogHash);
    });

    it('should use empty string when neither chainSeed nor previousLogHash is present', async () => {
      const entryData = {
        id: 'orphan',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        userId: 'u1',
        actorEmail: 'test@example.com',
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-orphan',
        driveId: 'drive-1',
      };
      const logHash = computeLogHash(entryData, '');

      mockFindFirst.mockResolvedValueOnce({
        ...entryData,
        pageId: null,
        contentSnapshot: null,
        previousValues: null,
        newValues: null,
        metadata: null,
        previousLogHash: null,
        logHash,
        chainSeed: null,
      });

      const result = await verifyEntry('orphan');

      expect(result?.isValid).toBe(true);
      expect(result?.previousHashUsed).toBe('');
    });

    it('should return isValid=false for a tampered entry', async () => {
      const chain = buildValidChain(1);
      const entry = chain[0]!;

      mockFindFirst.mockResolvedValueOnce({
        ...entry,
        logHash: 'tampered-hash-0000000000000000000000000000000000000000000000',
        pageId: null,
        contentSnapshot: null,
        previousValues: null,
        newValues: null,
        metadata: null,
      });

      const result = await verifyEntry(entry.id);

      expect(result?.isValid).toBe(false);
      expect(result?.storedHash).toBe('tampered-hash-0000000000000000000000000000000000000000000000');
    });

    it('should throw on DB error', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('entry db fail'));

      await expect(verifyEntry('some-id')).rejects.toThrow('entry db fail');
    });

    it('should correctly handle entry with optional fields', async () => {
      const baseData = {
        id: 'full-entry',
        timestamp: new Date('2024-06-01T12:00:00.000Z'),
        userId: 'u1',
        actorEmail: 'test@example.com',
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
        pageId: 'page-1',
        contentSnapshot: 'some content',
        previousValues: { title: 'old' },
        newValues: { title: 'new' },
        metadata: { key: 'value' },
      };
      const seed = generateChainSeed();
      const logHash = computeLogHash(baseData, seed);

      mockFindFirst.mockResolvedValueOnce({
        ...baseData,
        previousLogHash: null,
        logHash,
        chainSeed: seed,
      });

      const result = await verifyEntry('full-entry');

      expect(result?.isValid).toBe(true);
    });
  });
});
