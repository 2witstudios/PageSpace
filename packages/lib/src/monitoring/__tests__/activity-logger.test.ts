/**
 * Comprehensive tests for activity-logger.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock factories ────────────────────────────────────────────────────
const capturedState = vi.hoisted(() => ({
  insertValues: null as Record<string, unknown> | null,
  logEntries: [] as Array<{ logHash: string }>,
}));

const mockInsertValues = vi.hoisted(() =>
  vi.fn().mockImplementation((values: Record<string, unknown>) => {
    capturedState.insertValues = values;
    return Promise.resolve(undefined);
  })
);
const mockInsert = vi.hoisted(() => vi.fn().mockReturnValue({ values: mockInsertValues }));
const mockFindFirst = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {
    if (capturedState.logEntries.length > 0) {
      return Promise.resolve(capturedState.logEntries[capturedState.logEntries.length - 1]);
    }
    return Promise.resolve(null);
  })
);
const mockUsersFindFirst = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db', () => ({
  db: {
    insert: mockInsert,
    query: {
      activityLogs: { findFirst: mockFindFirst },
      users: { findFirst: mockUsersFindFirst },
    },
  },
  activityLogs: { id: 'id', logHash: 'logHash', timestamp: 'timestamp' },
  users: { id: 'id' },
  eq: vi.fn((col, val) => ({ type: 'eq', col, val })),
}));

vi.mock('drizzle-orm', () => ({
  desc: vi.fn((col) => col),
  isNotNull: vi.fn((col) => col),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-activity-id'),
}));

// ── Import after mocking ──────────────────────────────────────────────────────
import { db } from '@pagespace/db';
import {
  getActorInfo,
  generateChainSeed,
  computeHash,
  serializeLogDataForHash,
  computeLogHash,
  getLatestLogHash,
  getLatestLogHashWithTx,
  computeHashChainData,
  verifyLogHash,
  logActivity,
  logActivityWithTx,
  logPageActivity,
  logPermissionActivity,
  logDriveActivity,
  logAgentConfigActivity,
  logMemberActivity,
  logRoleActivity,
  logUserActivity,
  logTokenActivity,
  logFileActivity,
  logMessageActivity,
  logRollbackActivity,
  logConversationUndo,
  setActivityBroadcastHook,
  setWorkflowTriggerHook,
  type ActivityLogInput,
} from '../activity-logger';

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

const baseHashData = {
  id: 'log-1',
  timestamp: new Date('2024-01-01T00:00:00.000Z'),
  operation: 'create',
  resourceType: 'page',
  resourceId: 'page-1',
  driveId: 'drive-1',
};

describe('activity-logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedState.insertValues = null;
    capturedState.logEntries = [];
    setActivityBroadcastHook(null);
    setWorkflowTriggerHook(null);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockImplementation((values: Record<string, unknown>) => {
      capturedState.insertValues = values;
      return Promise.resolve(undefined);
    });
    mockFindFirst.mockImplementation(() => {
      if (capturedState.logEntries.length > 0) {
        return Promise.resolve(capturedState.logEntries[capturedState.logEntries.length - 1]);
      }
      return Promise.resolve(null);
    });
  });

  // ── getActorInfo ──────────────────────────────────────────────────────────
  describe('getActorInfo', () => {
    it('should return actorEmail and actorDisplayName when user is found', async () => {
      mockUsersFindFirst.mockResolvedValue({ email: 'john@example.com', name: 'John Doe' });
      const result = await getActorInfo('user-1');
      expect(result.actorEmail).toBe('john@example.com');
      expect(result.actorDisplayName).toBe('John Doe');
    });

    it('should return actorDisplayName as undefined when name is null', async () => {
      mockUsersFindFirst.mockResolvedValue({ email: 'john@example.com', name: null });
      const result = await getActorInfo('user-1');
      expect(result.actorEmail).toBe('john@example.com');
      expect(result.actorDisplayName).toBeUndefined();
    });

    it('should return fallback when user is not found', async () => {
      mockUsersFindFirst.mockResolvedValue(null);
      const result = await getActorInfo('nonexistent');
      expect(result.actorEmail).toBe('unknown@system');
    });

    it('should return fallback on DB error', async () => {
      mockUsersFindFirst.mockRejectedValue(new Error('DB connection failed'));
      const result = await getActorInfo('user-1');
      expect(result.actorEmail).toBe('unknown@system');
    });
  });

  // ── generateChainSeed ─────────────────────────────────────────────────────
  describe('generateChainSeed', () => {
    it('should return a 64-character hex string', () => {
      const seed = generateChainSeed();
      expect(seed).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(seed)).toBe(true);
    });

    it('should return different values on each call', () => {
      expect(generateChainSeed()).not.toBe(generateChainSeed());
    });
  });

  // ── computeHash ───────────────────────────────────────────────────────────
  describe('computeHash', () => {
    it('should return a 64-char SHA-256 hex string', () => {
      expect(computeHash('data', 'prevhash')).toHaveLength(64);
    });

    it('should be deterministic for same inputs', () => {
      expect(computeHash('data', 'prev')).toBe(computeHash('data', 'prev'));
    });

    it('should differ for different data', () => {
      expect(computeHash('a', 'prev')).not.toBe(computeHash('b', 'prev'));
    });

    it('should differ for different previousHash', () => {
      expect(computeHash('data', 'a')).not.toBe(computeHash('data', 'b'));
    });
  });

  // ── serializeLogDataForHash ───────────────────────────────────────────────
  describe('serializeLogDataForHash', () => {
    it('should return a deterministic JSON string', () => {
      expect(serializeLogDataForHash(baseHashData)).toBe(serializeLogDataForHash(baseHashData));
    });

    it('should include required non-PII fields', () => {
      const parsed = JSON.parse(serializeLogDataForHash(baseHashData));
      expect(parsed.id).toBe('log-1');
      expect(parsed.operation).toBe('create');
      expect(parsed.resourceType).toBe('page');
    });

    it('should not contain PII fields (userId, actorEmail)', () => {
      const parsed = JSON.parse(serializeLogDataForHash(baseHashData));
      expect(parsed).not.toHaveProperty('userId');
      expect(parsed).not.toHaveProperty('actorEmail');
    });

    it('should use null for absent optional fields', () => {
      const parsed = JSON.parse(serializeLogDataForHash(baseHashData));
      expect(parsed.pageId).toBeNull();
      expect(parsed.contentSnapshot).toBeNull();
    });

    it('should include optional fields when provided', () => {
      const data = { ...baseHashData, pageId: 'p1', contentSnapshot: 'content', previousValues: { a: 1 }, newValues: { b: 2 }, metadata: { k: 'v' } };
      const parsed = JSON.parse(serializeLogDataForHash(data));
      expect(parsed.pageId).toBe('p1');
      expect(parsed.contentSnapshot).toBe('content');
    });

    it('should serialize timestamp as ISO string', () => {
      const parsed = JSON.parse(serializeLogDataForHash(baseHashData));
      expect(parsed.timestamp).toBe(baseHashData.timestamp.toISOString());
    });
  });

  // ── computeLogHash ────────────────────────────────────────────────────────
  describe('computeLogHash', () => {
    it('should return a 64-char hex hash', () => {
      expect(computeLogHash(baseHashData, 'prev')).toHaveLength(64);
    });

    it('should be deterministic', () => {
      expect(computeLogHash(baseHashData, 'prev')).toBe(computeLogHash(baseHashData, 'prev'));
    });

    it('should differ when previousHash differs', () => {
      expect(computeLogHash(baseHashData, 'a')).not.toBe(computeLogHash(baseHashData, 'b'));
    });
  });

  // ── getLatestLogHash ──────────────────────────────────────────────────────
  describe('getLatestLogHash', () => {
    it('should return isFirstEntry=true when no entries', async () => {
      mockFindFirst.mockResolvedValue(null);
      const result = await getLatestLogHash();
      expect(result.isFirstEntry).toBe(true);
      expect(result.previousHash).toBeNull();
    });

    it('should return the latest hash when entries exist', async () => {
      mockFindFirst.mockResolvedValue({ logHash: 'abc123' });
      const result = await getLatestLogHash();
      expect(result.isFirstEntry).toBe(false);
      expect(result.previousHash).toBe('abc123');
    });

    it('should return isFirstEntry=true when entry has no logHash', async () => {
      mockFindFirst.mockResolvedValue({ logHash: null });
      const result = await getLatestLogHash();
      expect(result.isFirstEntry).toBe(true);
      expect(result.previousHash).toBeNull();
    });

    it('should return null previousHash on DB error', async () => {
      mockFindFirst.mockRejectedValue(new Error('db error'));
      const result = await getLatestLogHash();
      expect(result.previousHash).toBeNull();
      expect(result.isFirstEntry).toBe(false);
    });
  });

  // ── getLatestLogHashWithTx ────────────────────────────────────────────────
  describe('getLatestLogHashWithTx', () => {
    it('should query from the given tx object', async () => {
      const mockTx = {
        query: { activityLogs: { findFirst: vi.fn().mockResolvedValue({ logHash: 'txhash' }) } },
      } as unknown as typeof db;
      const result = await getLatestLogHashWithTx(mockTx);
      expect(result.isFirstEntry).toBe(false);
      expect(result.previousHash).toBe('txhash');
    });

    it('should return isFirstEntry=true when tx returns null', async () => {
      const mockTx = {
        query: { activityLogs: { findFirst: vi.fn().mockResolvedValue(null) } },
      } as unknown as typeof db;
      const result = await getLatestLogHashWithTx(mockTx);
      expect(result.isFirstEntry).toBe(true);
    });

    it('should handle tx error gracefully', async () => {
      const mockTx = {
        query: { activityLogs: { findFirst: vi.fn().mockRejectedValue(new Error('tx error')) } },
      } as unknown as typeof db;
      const result = await getLatestLogHashWithTx(mockTx);
      expect(result.previousHash).toBeNull();
    });
  });

  // ── computeHashChainData ──────────────────────────────────────────────────
  describe('computeHashChainData', () => {
    it('should generate chainSeed for the first entry', () => {
      const data = computeHashChainData(baseHashData, null, true);
      expect(data.chainSeed).toHaveLength(64);
      expect(data.previousLogHash).toBeNull();
      expect(data.logHash).toHaveLength(64);
    });

    it('should not generate chainSeed for subsequent entries', () => {
      const data = computeHashChainData(baseHashData, 'prevhash', false);
      expect(data.chainSeed).toBeNull();
      expect(data.previousLogHash).toBe('prevhash');
    });
  });

  // ── verifyLogHash ─────────────────────────────────────────────────────────
  describe('verifyLogHash', () => {
    it('should return true when hash is valid', () => {
      const h = computeLogHash(baseHashData, 'prev');
      expect(verifyLogHash(baseHashData, h, 'prev')).toBe(true);
    });

    it('should return false when hash does not match', () => {
      expect(verifyLogHash(baseHashData, 'wrong', 'prev')).toBe(false);
    });

    it('should return false when non-PII data is modified', () => {
      const h = computeLogHash(baseHashData, 'prev');
      expect(verifyLogHash({ ...baseHashData, operation: 'delete' }, h, 'prev')).toBe(false);
    });

    it('should verify identical data produces matching hash', () => {
      const h = computeLogHash(baseHashData, 'prev');
      expect(verifyLogHash({ ...baseHashData }, h, 'prev')).toBe(true);
    });
  });

  // ── GDPR-Safe Hash Chain (#541) ──────────────────────────────────────────
  describe('GDPR-Safe Hash Chain (#541)', () => {
    it('hash only depends on non-PII fields', () => {
      const hash1 = computeLogHash({
        id: 'log-1',
        timestamp: new Date('2026-01-25T10:00:00Z'),
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      }, 'prev-hash');

      // Same non-PII fields, same hash — regardless of what PII existed on the row
      const hash2 = computeLogHash({
        id: 'log-1',
        timestamp: new Date('2026-01-25T10:00:00Z'),
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      }, 'prev-hash');

      expect(hash1).toBe(hash2);
    });

    it('hash changes when non-PII fields change', () => {
      const base = {
        id: 'log-1',
        timestamp: new Date('2026-01-25T10:00:00Z'),
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      const hash1 = computeLogHash(base, 'prev');
      const hash2 = computeLogHash({ ...base, resourceId: 'page-2' }, 'prev');

      expect(hash1).not.toBe(hash2);
    });

    it('serialized hash data contains zero PII fields', () => {
      const serialized = serializeLogDataForHash({
        id: 'log-1',
        timestamp: new Date('2026-01-25T10:00:00Z'),
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      });

      const parsed = JSON.parse(serialized);
      expect(Object.keys(parsed).sort()).toEqual([
        'contentSnapshot', 'driveId', 'id', 'metadata', 'newValues',
        'operation', 'pageId', 'previousValues', 'resourceId',
        'resourceType', 'timestamp',
      ]);
    });

    it('chain remains valid when entries are recomputed', () => {
      const seed = 'a'.repeat(64);
      const entry1 = {
        id: 'log-chain-1',
        timestamp: new Date('2026-01-25T10:00:00Z'),
        operation: 'create',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      const hash1 = computeLogHash(entry1, seed);

      const entry2 = {
        id: 'log-chain-2',
        timestamp: new Date('2026-01-25T10:01:00Z'),
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
      };

      const hash2 = computeLogHash(entry2, hash1);

      // Recompute chain from same data — hashes must be identical
      const reHash1 = computeLogHash(entry1, seed);
      const reHash2 = computeLogHash(entry2, reHash1);

      expect(reHash1).toBe(hash1);
      expect(reHash2).toBe(hash2);
    });
  });

  // ── logActivity ───────────────────────────────────────────────────────────
  describe('logActivity', () => {
    const baseInput: ActivityLogInput = {
      userId: 'user-1',
      actorEmail: 'john@example.com',
      operation: 'create',
      resourceType: 'page',
      resourceId: 'page-1',
      driveId: 'drive-1',
    };

    it('should insert with hash chain fields', async () => {
      await logActivity(baseInput);
      expect(capturedState.insertValues).toMatchObject({
        userId: 'user-1',
        actorEmail: 'john@example.com',
      });
      expect((capturedState.insertValues?.logHash as string)).toHaveLength(64);
    });

    it('should insert chainSeed for the first entry', async () => {
      mockFindFirst.mockResolvedValue(null);
      await logActivity(baseInput);
      expect(capturedState.insertValues?.chainSeed).toBeDefined();
      expect(capturedState.insertValues?.previousLogHash).toBeNull();
    });

    it('should set isArchived=false', async () => {
      await logActivity(baseInput);
      expect(capturedState.insertValues?.isArchived).toBe(false);
    });

    it('should set isAiGenerated=false by default', async () => {
      await logActivity(baseInput);
      expect(capturedState.insertValues?.isAiGenerated).toBe(false);
    });

    it('should call broadcast hook when set', async () => {
      const broadcastHook = vi.fn().mockResolvedValue(undefined);
      setActivityBroadcastHook(broadcastHook);
      await logActivity(baseInput);
      expect(broadcastHook).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create', resourceId: 'page-1' }));
    });

    it('should call workflow hook when set', async () => {
      const workflowHook = vi.fn().mockResolvedValue(undefined);
      setWorkflowTriggerHook(workflowHook);
      await logActivity(baseInput);
      expect(workflowHook).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create' }));
    });

    it('should not throw when broadcast hook fails', async () => {
      setActivityBroadcastHook(vi.fn().mockRejectedValue(new Error('broadcast failed')));
      await expect(logActivity(baseInput)).resolves.toBeUndefined();
    });

    it('should truncate content snapshot when it exceeds 1MB', async () => {
      await logActivity({ ...baseInput, contentSnapshot: 'x'.repeat(1024 * 1024 + 1) });
      expect(capturedState.insertValues?.contentSnapshot).toBeUndefined();
      expect((capturedState.insertValues?.metadata as Record<string, unknown>)?.contentSnapshotSkipped).toBe(true);
    });

    it('should keep content snapshot under 1MB', async () => {
      await logActivity({ ...baseInput, contentSnapshot: 'hello' });
      expect(capturedState.insertValues?.contentSnapshot).toBe('hello');
    });

    it('should retry without pageId on FK constraint violation', async () => {
      const fkError = Object.assign(new Error('FK error'), {
        code: '23503',
        constraint: 'activity_logs_pageId_pages_id_fk',
      });
      let callCount = 0;
      mockInsertValues.mockImplementation((values: Record<string, unknown>) => {
        callCount++;
        if (callCount === 1) return Promise.reject(fkError);
        capturedState.insertValues = values;
        return Promise.resolve(undefined);
      });
      await logActivity({ ...baseInput, pageId: 'page-1' });
      expect(callCount).toBe(2);
      expect(capturedState.insertValues?.pageId).toBeUndefined();
    });

    it('should not retry on non-FK errors', async () => {
      mockInsertValues.mockRejectedValue(new Error('Generic DB error'));
      await expect(logActivity(baseInput)).resolves.toBeUndefined();
    });

    it('should not retry when FK error but no pageId', async () => {
      const fkError = Object.assign(new Error('FK error'), {
        code: '23503',
        constraint: 'activity_logs_pageId_pages_id_fk',
      });
      let callCount = 0;
      mockInsertValues.mockImplementation(() => {
        callCount++;
        return Promise.reject(fkError);
      });
      await logActivity(baseInput); // no pageId
      expect(callCount).toBe(1);
    });

    it('should log error and return when retry also fails', async () => {
      const fkError = Object.assign(new Error('FK error'), {
        code: '23503',
        constraint: 'activity_logs_pageId_pages_id_fk',
      });
      mockInsertValues.mockRejectedValue(fkError);
      await expect(logActivity({ ...baseInput, pageId: 'page-1' })).resolves.toBeUndefined();
    });
  });

  // ── logActivityWithTx ─────────────────────────────────────────────────────
  describe('logActivityWithTx', () => {
    const baseInput: ActivityLogInput = {
      userId: 'user-1',
      actorEmail: 'john@example.com',
      operation: 'update',
      resourceType: 'page',
      resourceId: 'page-1',
      driveId: 'drive-1',
    };

    function makeTx(insertValuesFn = vi.fn().mockResolvedValue(undefined)) {
      return {
        insert: vi.fn().mockReturnValue({ values: insertValuesFn }),
        query: { activityLogs: { findFirst: vi.fn().mockResolvedValue(null) } },
      } as unknown as typeof db;
    }

    it('should insert into the provided transaction', async () => {
      const txValues = vi.fn().mockResolvedValue(undefined);
      const mockTx = makeTx(txValues);
      await logActivityWithTx(baseInput, mockTx);
      expect(mockTx.insert).toHaveBeenCalled();
      expect(txValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    });

    it('should return a deferred workflow trigger when workflow hook is set', async () => {
      const workflowHook = vi.fn().mockResolvedValue(undefined);
      setWorkflowTriggerHook(workflowHook);
      const mockTx = makeTx();
      const deferred = await logActivityWithTx(baseInput, mockTx);
      expect(typeof deferred).toBe('function');
      deferred!();
      await flush();
      expect(workflowHook).toHaveBeenCalled();
    });

    it('should return undefined when no workflow hook is set', async () => {
      setWorkflowTriggerHook(null);
      const mockTx = makeTx();
      const deferred = await logActivityWithTx(baseInput, mockTx);
      expect(deferred).toBeUndefined();
    });

    it('should call broadcast hook when set', async () => {
      const broadcastHook = vi.fn().mockResolvedValue(undefined);
      setActivityBroadcastHook(broadcastHook);
      await logActivityWithTx(baseInput, makeTx());
      expect(broadcastHook).toHaveBeenCalled();
    });
  });

  // ── setActivityBroadcastHook ──────────────────────────────────────────────
  describe('setActivityBroadcastHook', () => {
    it('should store and call the hook', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      setActivityBroadcastHook(fn);
      await logActivity({ userId: 'u1', actorEmail: 'a@b.com', operation: 'create', resourceType: 'page', resourceId: 'p1', driveId: 'd1' });
      expect(fn).toHaveBeenCalled();
    });

    it('should clear the hook when passed null', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      setActivityBroadcastHook(fn);
      setActivityBroadcastHook(null);
      await logActivity({ userId: 'u1', actorEmail: 'a@b.com', operation: 'create', resourceType: 'page', resourceId: 'p1', driveId: 'd1' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ── setWorkflowTriggerHook ────────────────────────────────────────────────
  describe('setWorkflowTriggerHook', () => {
    it('should store and call the hook', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      setWorkflowTriggerHook(fn);
      await logActivity({ userId: 'u1', actorEmail: 'a@b.com', operation: 'update', resourceType: 'page', resourceId: 'p1', driveId: 'd1' });
      expect(fn).toHaveBeenCalled();
    });

    it('should clear the hook when passed null', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      setWorkflowTriggerHook(fn);
      setWorkflowTriggerHook(null);
      await logActivity({ userId: 'u1', actorEmail: 'a@b.com', operation: 'update', resourceType: 'page', resourceId: 'p1', driveId: 'd1' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ── logPageActivity ───────────────────────────────────────────────────────
  describe('logPageActivity', () => {
    it('should call logActivity with page resource type', async () => {
      logPageActivity('u1', 'create', { id: 'p1', title: 'My Page', driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('page');
    });

    it('should omit pageId for delete operation', async () => {
      logPageActivity('u1', 'delete', { id: 'p1', driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.pageId).toBeUndefined();
    });

    it('should include pageId for non-delete operations', async () => {
      logPageActivity('u1', 'update', { id: 'p1', driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.pageId).toBe('p1');
    });

    it('should default actorEmail to unknown@system', async () => {
      logPageActivity('u1', 'create', { id: 'p1', driveId: 'd1' });
      await flush();
      expect(capturedState.insertValues?.actorEmail).toBe('unknown@system');
    });

    it('should pass all optional fields', async () => {
      logPageActivity(
        'u1', 'update',
        { id: 'p1', driveId: 'd1', content: 'some content' },
        { actorEmail: 'a@b.com', isAiGenerated: true, aiProvider: 'openai', aiModel: 'gpt-4o', aiConversationId: 'c1',
          updatedFields: ['title'], previousValues: { title: 'old' }, newValues: { title: 'new' },
          metadata: { k: 'v' }, contentRef: 'ref', contentSize: 100, contentFormat: 'tiptap',
          streamId: 's1', streamSeq: 1, changeGroupId: 'cg1', changeGroupType: 'ai',
          stateHashBefore: 'before', stateHashAfter: 'after' }
      );
      await flush();
      expect(capturedState.insertValues?.isAiGenerated).toBe(true);
      expect(capturedState.insertValues?.contentSnapshot).toBe('some content');
    });
  });

  // ── logPermissionActivity ─────────────────────────────────────────────────
  describe('logPermissionActivity', () => {
    it('should log with permission resource type', async () => {
      logPermissionActivity('u1', 'permission_grant', { pageId: 'p1', driveId: 'd1', targetUserId: 'u2', permissions: { canView: true } }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('permission');
      expect(capturedState.insertValues?.operation).toBe('permission_grant');
    });

    it('should include targetUserId in metadata', async () => {
      logPermissionActivity('u1', 'permission_revoke', { pageId: 'p1', driveId: 'd1', targetUserId: 'u2' }, { actorEmail: 'a@b.com' });
      await flush();
      expect((capturedState.insertValues?.metadata as Record<string, unknown>)?.targetUserId).toBe('u2');
    });

    it('should include previousValues when provided', async () => {
      logPermissionActivity('u1', 'permission_update', { pageId: 'p1', driveId: 'd1', targetUserId: 'u2' }, { actorEmail: 'a@b.com', previousValues: { canView: true } });
      await flush();
      expect(capturedState.insertValues?.previousValues).toEqual({ canView: true });
    });

    it('should include reason in metadata when provided', async () => {
      logPermissionActivity('u1', 'permission_revoke', { pageId: 'p1', driveId: 'd1', targetUserId: 'u2' }, { actorEmail: 'a@b.com', reason: 'member_removal' });
      await flush();
      expect((capturedState.insertValues?.metadata as Record<string, unknown>)?.reason).toBe('member_removal');
    });
  });

  // ── logDriveActivity ──────────────────────────────────────────────────────
  describe('logDriveActivity', () => {
    it('should log with drive resource type', async () => {
      logDriveActivity('u1', 'create', { id: 'd1', name: 'My Drive' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('drive');
    });

    it('should pass AI fields', async () => {
      logDriveActivity('u1', 'update', { id: 'd1' }, { actorEmail: 'a@b.com', isAiGenerated: true, aiProvider: 'openai', aiModel: 'gpt-4o', aiConversationId: 'c1' });
      await flush();
      expect(capturedState.insertValues?.isAiGenerated).toBe(true);
    });
  });

  // ── logAgentConfigActivity ────────────────────────────────────────────────
  describe('logAgentConfigActivity', () => {
    it('should log agent_config_update operation', async () => {
      logAgentConfigActivity('u1', { id: 'a1', name: 'Agent', driveId: 'd1' }, { updatedFields: ['prompt'] }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.operation).toBe('agent_config_update');
      expect(capturedState.insertValues?.resourceType).toBe('agent');
    });

    it('should use agent id as pageId', async () => {
      logAgentConfigActivity('u1', { id: 'a1', driveId: 'd1' }, {}, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.pageId).toBe('a1');
    });
  });

  // ── logMemberActivity ─────────────────────────────────────────────────────
  describe('logMemberActivity', () => {
    it('should log member_add operation', async () => {
      logMemberActivity('u1', 'member_add', { driveId: 'd1', targetUserId: 'u2', role: 'editor' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.operation).toBe('member_add');
    });

    it('should build previousValues for member_remove', async () => {
      logMemberActivity('u1', 'member_remove', {
        driveId: 'd1', targetUserId: 'u2', role: 'editor', previousRole: 'viewer',
        customRoleId: 'cr-1', previousCustomRoleId: null,
        invitedBy: 'u1', invitedAt: new Date('2024-01-01'), acceptedAt: new Date('2024-01-02'),
      }, { actorEmail: 'a@b.com' });
      await flush();
      const prev = capturedState.insertValues?.previousValues as Record<string, unknown>;
      expect(prev?.role).toBe('viewer');
      expect(prev?.invitedBy).toBe('u1');
    });

    it('should build previousValues for member_role_change with previousRole', async () => {
      logMemberActivity('u1', 'member_role_change', { driveId: 'd1', targetUserId: 'u2', role: 'editor', previousRole: 'viewer', previousCustomRoleId: 'cr-old' }, { actorEmail: 'a@b.com' });
      await flush();
      const prev = capturedState.insertValues?.previousValues as Record<string, unknown>;
      expect(prev?.role).toBe('viewer');
      expect(prev?.customRoleId).toBe('cr-old');
    });

    it('should not set previousValues for member_add', async () => {
      logMemberActivity('u1', 'member_add', { driveId: 'd1', targetUserId: 'u2' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toBeUndefined();
    });
  });

  // ── logRoleActivity ───────────────────────────────────────────────────────
  describe('logRoleActivity', () => {
    it('should log role_reorder with order values', async () => {
      logRoleActivity('u1', 'role_reorder', { driveId: 'd1', previousOrder: ['r1', 'r2'], newOrder: ['r2', 'r1'] }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toEqual({ order: ['r1', 'r2'] });
      expect(capturedState.insertValues?.newValues).toEqual({ order: ['r2', 'r1'] });
    });

    it('should log role create with permissions', async () => {
      logRoleActivity('u1', 'create', { roleId: 'r1', driveId: 'd1', permissions: { canEdit: true }, previousPermissions: { canEdit: false } }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.newValues).toEqual({ permissions: { canEdit: true } });
      expect(capturedState.insertValues?.previousValues).toEqual({ permissions: { canEdit: false } });
    });

    it('should use driveId as resourceId for role_reorder', async () => {
      logRoleActivity('u1', 'role_reorder', { driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceId).toBe('d1');
    });

    it('should not set metadata for non-reorder operations', async () => {
      logRoleActivity('u1', 'delete', { roleId: 'r1', driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.metadata).toBeUndefined();
    });

    it('should set driveName in metadata for role_reorder', async () => {
      logRoleActivity('u1', 'role_reorder', { driveId: 'd1', driveName: 'My Drive' }, { actorEmail: 'a@b.com' });
      await flush();
      expect((capturedState.insertValues?.metadata as Record<string, unknown>)?.driveName).toBe('My Drive');
    });
  });

  // ── logUserActivity ───────────────────────────────────────────────────────
  describe('logUserActivity', () => {
    it('should log with null driveId', async () => {
      logUserActivity('u1', 'login', { targetUserId: 'u1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('user');
      expect(capturedState.insertValues?.driveId).toBeNull();
    });

    it('should set previousValues when previousEmail provided', async () => {
      logUserActivity('u1', 'email_change', { targetUserId: 'u1', previousEmail: 'old@b.com', newEmail: 'new@b.com' }, { actorEmail: 'old@b.com' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toEqual({ email: 'old@b.com' });
      expect(capturedState.insertValues?.newValues).toEqual({ email: 'new@b.com' });
    });

    it('should not set previousValues when previousEmail is absent', async () => {
      logUserActivity('u1', 'profile_update', { targetUserId: 'u1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toBeUndefined();
    });
  });

  // ── logTokenActivity ──────────────────────────────────────────────────────
  describe('logTokenActivity', () => {
    it('should log token resource type for mcp tokens', async () => {
      logTokenActivity('u1', 'token_create', { tokenId: 't1', tokenType: 'mcp' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('token');
    });

    it('should log device resource type for device tokens', async () => {
      logTokenActivity('u1', 'token_create', { tokenId: 't1', tokenType: 'device' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('device');
    });

    it('should log token resource type for api tokens', async () => {
      logTokenActivity('u1', 'token_revoke', { tokenId: 't1', tokenType: 'api' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('token');
    });
  });

  // ── logFileActivity ───────────────────────────────────────────────────────
  describe('logFileActivity', () => {
    it('should log file upload operation', async () => {
      logFileActivity('u1', 'upload', { fileId: 'f1', fileName: 'doc.pdf', fileType: 'pdf', fileSize: 1024, driveId: 'd1', pageId: 'p1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.resourceType).toBe('file');
      expect(capturedState.insertValues?.pageId).toBe('p1');
    });
  });

  // ── logMessageActivity ────────────────────────────────────────────────────
  describe('logMessageActivity', () => {
    it('should log message_update with content tracking', async () => {
      logMessageActivity('u1', 'message_update', { id: 'msg-1', pageId: 'p1', driveId: 'd1', conversationType: 'ai_chat' }, { actorEmail: 'a@b.com' }, { previousContent: 'old', newContent: 'new' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toEqual({ content: 'old' });
      expect(capturedState.insertValues?.newValues).toEqual({ content: 'new' });
    });

    it('should include conversationType in metadata', async () => {
      logMessageActivity('u1', 'message_delete', { id: 'msg-1', pageId: 'p1', driveId: null, conversationType: 'global' }, { actorEmail: 'a@b.com' });
      await flush();
      expect((capturedState.insertValues?.metadata as Record<string, unknown>)?.conversationType).toBe('global');
    });

    it('should not set previousValues when previousContent is absent', async () => {
      logMessageActivity('u1', 'create', { id: 'msg-1', pageId: 'p1', driveId: 'd1', conversationType: 'channel' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.previousValues).toBeUndefined();
    });
  });

  // ── logRollbackActivity ───────────────────────────────────────────────────
  describe('logRollbackActivity', () => {
    it('should log rollback operation', async () => {
      await logRollbackActivity('u1', 'src-act-1', { resourceType: 'page', resourceId: 'p1', driveId: 'd1' }, { actorEmail: 'a@b.com' });
      await flush();
      expect(capturedState.insertValues?.operation).toBe('rollback');
      expect(capturedState.insertValues?.rollbackFromActivityId).toBe('src-act-1');
    });

    it('should use logActivityWithTx when tx is provided', async () => {
      const txValues = vi.fn().mockResolvedValue(undefined);
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: txValues }),
        query: { activityLogs: { findFirst: vi.fn().mockResolvedValue(null) } },
      } as unknown as typeof db;
      await logRollbackActivity('u1', 'src-act-1', { resourceType: 'page', resourceId: 'p1', driveId: 'd1' }, { actorEmail: 'a@b.com' }, { tx: mockTx });
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('should map restoredValues to newValues and replacedValues to previousValues', async () => {
      await logRollbackActivity('u1', 'src', { resourceType: 'page', resourceId: 'p1', driveId: 'd1' }, { actorEmail: 'a@b.com' }, { restoredValues: { title: 'old' }, replacedValues: { title: 'current' } });
      await flush();
      expect(capturedState.insertValues?.newValues).toEqual({ title: 'old' });
      expect(capturedState.insertValues?.previousValues).toEqual({ title: 'current' });
    });
  });

  // ── logConversationUndo ───────────────────────────────────────────────────
  describe('logConversationUndo', () => {
    it('should log conversation_undo for messages_only mode', async () => {
      logConversationUndo('u1', 'conv-1', 'msg-1', { actorEmail: 'a@b.com' }, { mode: 'messages_only', messagesDeleted: 3, activitiesRolledBack: 0 });
      await flush();
      expect(capturedState.insertValues?.operation).toBe('conversation_undo');
    });

    it('should log conversation_undo_with_changes for messages_and_changes mode', async () => {
      logConversationUndo('u1', 'conv-1', 'msg-1', { actorEmail: 'a@b.com' }, { mode: 'messages_and_changes', messagesDeleted: 3, activitiesRolledBack: 2, rolledBackActivityIds: ['a1'] });
      await flush();
      expect(capturedState.insertValues?.operation).toBe('conversation_undo_with_changes');
    });

    it('should include undo metadata', async () => {
      logConversationUndo('u1', 'conv-1', 'msg-1', { actorEmail: 'a@b.com' }, { mode: 'messages_only', messagesDeleted: 5, activitiesRolledBack: 0, pageId: 'p1', driveId: 'd1' });
      await flush();
      const meta = capturedState.insertValues?.metadata as Record<string, unknown>;
      expect(meta?.messageId).toBe('msg-1');
      expect(meta?.messagesDeleted).toBe(5);
      expect(capturedState.insertValues?.pageId).toBe('p1');
    });

    it('should default driveId to null when not provided', async () => {
      logConversationUndo('u1', 'conv-1', 'msg-1', { actorEmail: 'a@b.com' }, { mode: 'messages_only', messagesDeleted: 1, activitiesRolledBack: 0 });
      await flush();
      expect(capturedState.insertValues?.driveId).toBeNull();
    });
  });
});
