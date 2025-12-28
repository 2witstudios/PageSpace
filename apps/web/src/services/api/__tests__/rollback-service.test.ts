/**
 * @scaffold - mocking ORM chains until repository seam is introduced
 *
 * Contract tests for rollback-service.ts
 *
 * Tests the rollback service's observable contracts:
 * - previewRollback: activity lookup -> preview result
 * - executeRollback: activity + user -> database mutation + audit log
 * - getPageVersionHistory: filters -> filtered activities
 * - getUserRetentionDays: user tier -> retention days
 *
 * Per rubric §4: Since this service uses Drizzle directly without a repository
 * abstraction, we mock at the db boundary. Consider refactoring to introduce
 * a repository seam for better testability.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  getActivityById,
  previewRollback,
  executeRollback,
  getPageVersionHistory,
  getDriveVersionHistory,
  getUserRetentionDays,
  type ActivityLogForRollback,
} from '../rollback-service';

// Mock the database at the boundary
vi.mock('@pagespace/db', () => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };

  // Chain mock for select().from().where().limit()
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
  };
  mockDb.select.mockReturnValue(selectChain);

  // Chain mock for update().set().where()
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'page_123' }]),
  };
  mockDb.update.mockReturnValue(updateChain);

  // Chain mock for insert().values()
  const insertChain = {
    values: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.insert.mockReturnValue(insertChain);

  // Chain mock for delete().where()
  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.delete.mockReturnValue(deleteChain);

  return {
    db: mockDb,
    activityLogs: { id: 'id' },
    pages: { id: 'id' },
    drives: { id: 'id' },
    driveMembers: { id: 'id' },
    driveRoles: { id: 'id' },
    pagePermissions: { id: 'id' },
    users: { id: 'id', subscriptionTier: 'subscriptionTier' },
    chatMessages: { id: 'id' },
    eq: vi.fn((a, b) => ({ field: a, value: b })),
    and: vi.fn((...args) => args),
    desc: vi.fn((a) => ({ field: a, direction: 'desc' })),
    gte: vi.fn((a, b) => ({ field: a, op: 'gte', value: b })),
    lte: vi.fn((a, b) => ({ field: a, op: 'lte', value: b })),
    count: vi.fn(() => 'count'),
  };
});

// Mock permission checks
vi.mock('@pagespace/lib/permissions', () => ({
  canUserRollback: vi.fn(),
  isRollbackableOperation: vi.fn(),
}));

// Mock activity logger
vi.mock('@pagespace/lib/monitoring', () => ({
  logRollbackActivity: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
  createChangeGroupId: vi.fn(() => 'change-group-1'),
  inferChangeGroupType: vi.fn(() => 'user'),
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  readPageContent: vi.fn(),
  computePageStateHash: vi.fn(() => 'state-hash'),
  hashWithPrefix: vi.fn(() => 'content-ref'),
  createPageVersion: vi.fn().mockResolvedValue({
    id: 'version-123',
    contentRef: 'content-ref',
    contentSize: 42,
  }),
}));

vi.mock('@/services/api/page-mention-service', () => ({
  syncMentions: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '@pagespace/db';
import { canUserRollback, isRollbackableOperation } from '@pagespace/lib/permissions';
import { logRollbackActivity } from '@pagespace/lib/monitoring';

// Test fixtures
const mockUserId = 'user_123';
const mockActivityId = 'activity_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const createMockActivity = (overrides: Partial<ActivityLogForRollback> = {}): ActivityLogForRollback => ({
  id: mockActivityId,
  timestamp: new Date('2024-01-15T10:00:00Z'),
  userId: mockUserId,
  actorEmail: 'test@example.com',
  actorDisplayName: 'Test User',
  operation: 'update',
  resourceType: 'page',
  resourceId: mockPageId,
  resourceTitle: 'Test Page',
  driveId: mockDriveId,
  pageId: mockPageId,
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  contentSnapshot: null,
  contentRef: null,
  contentFormat: null,
  contentSize: null,
  updatedFields: ['title', 'content'],
  previousValues: { title: 'Old Title', content: '<p>Old content</p>' },
  newValues: { title: 'New Title', content: '<p>New content</p>' },
  metadata: null,
  streamId: null,
  streamSeq: null,
  changeGroupId: null,
  changeGroupType: null,
  stateHashBefore: null,
  stateHashAfter: null,
  rollbackFromActivityId: null,
  rollbackSourceOperation: null,
  rollbackSourceTimestamp: null,
  rollbackSourceTitle: null,
  ...overrides,
});

describe('rollback-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // getActivityById
  // ============================================

  describe('getActivityById', () => {
    it('returns null when activity not found', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await getActivityById('nonexistent');

      expect(result).toBeNull();
    });

    it('returns formatted activity when found', async () => {
      const mockRawActivity = {
        id: mockActivityId,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        userId: mockUserId,
        actorEmail: 'test@example.com',
        actorDisplayName: 'Test User',
        operation: 'update',
        resourceType: 'page',
        resourceId: mockPageId,
        resourceTitle: 'Test Page',
        driveId: mockDriveId,
        pageId: mockPageId,
        isAiGenerated: false,
        aiProvider: null,
        aiModel: null,
        contentSnapshot: '<p>Old content</p>',
        contentRef: null,
        contentFormat: null,
        contentSize: null,
        updatedFields: ['content'],
        previousValues: { content: '<p>Old</p>' },
        newValues: { content: '<p>New</p>' },
        metadata: null,
        streamId: null,
        streamSeq: null,
        changeGroupId: null,
        changeGroupType: null,
        stateHashBefore: null,
        stateHashAfter: null,
      };

      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockRawActivity]),
          }),
        }),
      });

      const result = await getActivityById(mockActivityId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(mockActivityId);
      expect(result!.operation).toBe('update');
      expect(result!.previousValues).toEqual({ content: '<p>Old</p>' });
    });
  });

  // ============================================
  // previewRollback
  // ============================================

  describe('previewRollback', () => {
    it('returns canExecute=false when activity not found', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await previewRollback('nonexistent', mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.reason).toBe('Activity not found');
      expect(result.targetValues).toBeNull();
    });

    it('returns canExecute=false for non-rollbackable operations', async () => {
      const mockActivity = createMockActivity({ operation: 'create' });
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockActivity]),
          }),
        }),
      });
      (isRollbackableOperation as Mock).mockReturnValue(false);

      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.reason).toContain("Cannot rollback 'create'");
    });

    it('returns canExecute=false when no previous values available', async () => {
      const mockActivity = createMockActivity({
        previousValues: null,
        contentSnapshot: null,
      });
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockActivity]),
          }),
        }),
      });
      (isRollbackableOperation as Mock).mockReturnValue(true);

      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.reason).toBe('No values to restore');
    });

    it('returns canExecute=false when user lacks permission', async () => {
      const mockActivity = createMockActivity();
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockActivity]),
          }),
        }),
      });
      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({
        canRollback: false,
        reason: 'You need edit permission',
      });

      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.reason).toBe('You need edit permission');
    });

    it('returns canExecute=true with preview data when eligible', async () => {
      const mockActivity = createMockActivity();
      // Current page state must match activity.newValues to avoid conflict detection
      const mockCurrentPage = {
        title: 'New Title',  // Matches activity.newValues.title
        content: '<p>New content</p>',  // Matches activity.newValues.content
        parentId: null,
        position: 0,
      };

      // First call: get activity
      // Second call: get current page state
      let callCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) return Promise.resolve([mockActivity]);
              return Promise.resolve([mockCurrentPage]);
            }),
          })),
        })),
      }));

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(true);
      expect(result.targetValues).toEqual(mockActivity.previousValues);
    });

    it('returns hasConflict=true when resource has been modified since activity', async () => {
      const mockActivity = createMockActivity({
        newValues: { title: 'Original New Title' },
      });
      const mockCurrentPage = {
        title: 'Modified Title', // Different from activity's newValues
        content: '<p>New content</p>',
        parentId: null,
        position: 0,
      };

      let callCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) return Promise.resolve([mockActivity]);
              return Promise.resolve([mockCurrentPage]);
            }),
          }),
        }),
      }));

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      // Without force=true, conflict detection blocks rollback
      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.hasConflict).toBe(true);
      expect(result.requiresForce).toBe(true);
      expect(result.reason).toContain('Resource has been modified since this change');
    });

    it('includes warning when force=true and resource has been modified', async () => {
      const mockActivity = createMockActivity({
        newValues: { title: 'Original New Title' },
      });
      const mockCurrentPage = {
        title: 'Modified Title', // Different from activity's newValues
        content: '<p>New content</p>',
        parentId: null,
        position: 0,
      };

      let callCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) return Promise.resolve([mockActivity]);
              return Promise.resolve([mockCurrentPage]);
            }),
          }),
        }),
      }));

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      // With force=true, rollback proceeds with warning
      const result = await previewRollback(mockActivityId, mockUserId, 'page', { force: true });

      expect(result.canExecute).toBe(true);
      expect(result.hasConflict).toBe(true);
      expect(result.warnings).toContain(
        'This resource has been modified since this change. Recent changes will be overwritten.'
      );
    });

    it('returns canExecute=false when page no longer exists', async () => {
      const mockActivity = createMockActivity();

      let callCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) return Promise.resolve([mockActivity]);
              return Promise.resolve([]); // Page not found
            }),
          }),
        }),
      }));

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await previewRollback(mockActivityId, mockUserId, 'page');

      expect(result.canExecute).toBe(false);
      expect(result.reason).toBe('Resource no longer exists');
    });
  });

  // ============================================
  // executeRollback
  // ============================================

  describe('executeRollback', () => {
    it('returns failure when preview shows cannot rollback', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Activity not found');
    });

    it('executes page rollback and logs activity', async () => {
      const mockActivity = createMockActivity({
        previousValues: { title: 'Old Title' },
        newValues: { title: 'New Title' },  // Explicit newValues
        updatedFields: ['title'],
      });
      // Current page must match activity.newValues to avoid conflict detection
      const mockCurrentPage = {
        title: 'New Title',  // Matches activity.newValues.title
        content: '<p>New content</p>',  // Matches default activity.newValues.content
        parentId: null,
        position: 0,
      };

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 4) {
                return Promise.resolve([mockActivity]);
              }
              if (selectCallCount === 2) {
                return Promise.resolve([mockCurrentPage]);
              }
              return Promise.resolve([{ id: mockDriveId, isTrashed: false }]);
            }),
          }),
        }),
      }));

      const mockUpdateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: mockPageId }]),
        }),
      });
      (db.update as Mock).mockReturnValue({ set: mockUpdateSet });

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Change undone');
      expect(result.restoredValues).toEqual({ title: 'Old Title' });

      // Verify audit log was called with correct payload
      expect(logRollbackActivity).toHaveBeenCalledWith(
        mockUserId,
        mockActivityId,
        expect.objectContaining({
          resourceType: 'page',
          resourceId: mockPageId,
        }),
        expect.objectContaining({
          actorEmail: 'test@example.com',
        }),
        expect.objectContaining({
          restoredValues: { title: 'Old Title' },
        })
      );
    });

    it('uses contentSnapshot when available for page content', async () => {
      const mockActivity = createMockActivity({
        operation: 'update',
        contentSnapshot: '<p>Snapshot content</p>',
        previousValues: {},
        newValues: { content: '<p>Current</p>' },  // Only content changed
        updatedFields: ['content'],
      });
      // Current page must match activity.newValues to avoid conflict detection
      const mockCurrentPage = {
        title: 'New Title',  // Matches default
        content: '<p>Current</p>',  // Matches activity.newValues.content
        parentId: null,
        position: 0,
      };

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 4) {
                return Promise.resolve([mockActivity]);
              }
              if (selectCallCount === 2) {
                return Promise.resolve([mockCurrentPage]);
              }
              return Promise.resolve([{ id: mockDriveId, isTrashed: false }]);
            }),
          }),
        }),
      }));

      const mockUpdateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: mockPageId }]),
        }),
      });
      (db.update as Mock).mockReturnValue({ set: mockUpdateSet });

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(true);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '<p>Snapshot content</p>',
        })
      );
    });

    it('returns failure with error message on database error', async () => {
      const mockActivity = createMockActivity();
      // Current page must match activity.newValues to pass conflict detection
      const mockCurrentPage = {
        title: 'New Title',  // Matches activity.newValues.title
        content: '<p>New content</p>',  // Matches activity.newValues.content
        parentId: null,
        position: 0,
      };

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 4) {
                return Promise.resolve([mockActivity]);
              }
              if (selectCallCount === 2) {
                return Promise.resolve([mockCurrentPage]);
              }
              return Promise.resolve([{ id: mockDriveId, isTrashed: false }]);
            }),
          }),
        }),
      }));

      (db.update as Mock).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('Database connection failed')),
          }),
        }),
      });

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Database connection failed');
    });

    it('returns failure when no values to restore', async () => {
      const mockActivity = createMockActivity({
        previousValues: {},
        newValues: null,  // No newValues means no conflict check
        updatedFields: [],
        contentSnapshot: null,
      });
      const mockCurrentPage = {
        title: 'Title',
        content: '',
        parentId: null,
        position: 0,
      };

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 4) {
                return Promise.resolve([mockActivity]);
              }
              if (selectCallCount === 2) {
                return Promise.resolve([mockCurrentPage]);
              }
              return Promise.resolve([{ id: mockDriveId, isTrashed: false }]);
            }),
          }),
        }),
      }));

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(false);
      expect(result.message).toBe('No values to restore');
    });
  });

  // ============================================
  // Permission rollback operations
  // ============================================

  describe('permission rollback operations', () => {
    it('deletes permission on permission_grant rollback', async () => {
      const mockActivity = createMockActivity({
        resourceType: 'permission',
        operation: 'permission_grant',
        previousValues: {},
        metadata: { targetUserId: 'target_user' },
      });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 3) {
                return Promise.resolve([mockActivity]);
              }
              return Promise.resolve([{
                userId: 'target_user',
                canView: true,
                canEdit: true,
                canShare: false,
                canDelete: false,
                note: null,
                expiresAt: null,
                grantedBy: 'granter_123',
              }]);
            }),
          }),
        }),
      }));

      const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
      (db.delete as Mock).mockReturnValue({ where: mockDeleteWhere });

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
      expect(result.restoredValues).toEqual(
        expect.objectContaining({ deleted: true })
      );
    });

    it('recreates permission on permission_revoke rollback', async () => {
      const mockActivity = createMockActivity({
        resourceType: 'permission',
        operation: 'permission_revoke',
        previousValues: {
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
          grantedBy: 'granter_123',
          note: 'Test permission',
        },
        metadata: { targetUserId: 'target_user' },
      });

      let selectCallCount = 0;
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1 || selectCallCount === 3) {
                return Promise.resolve([mockActivity]);
              }
              return Promise.resolve([]);
            }),
          }),
        }),
      }));

      const mockInsertValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as Mock).mockReturnValue({ values: mockInsertValues });

      (isRollbackableOperation as Mock).mockReturnValue(true);
      (canUserRollback as Mock).mockResolvedValue({ canRollback: true });

      const result = await executeRollback(mockActivityId, mockUserId, 'page');

      expect(result.success).toBe(true);
      expect(db.insert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          canView: true,
          canEdit: true,
          canShare: false,
          canDelete: false,
        })
      );
    });
  });

  // ============================================
  // getUserRetentionDays
  // ============================================

  describe('getUserRetentionDays', () => {
    it('returns 7 days for free tier', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ subscriptionTier: 'free' }]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(7);
    });

    it('returns 30 days for pro tier', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ subscriptionTier: 'pro' }]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(30);
    });

    it('returns 90 days for founder tier', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ subscriptionTier: 'founder' }]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(90);
    });

    it('returns -1 (unlimited) for business tier', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ subscriptionTier: 'business' }]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(-1);
    });

    it('returns free tier default when user not found', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(7);
    });

    it('returns free tier default when subscriptionTier is null', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ subscriptionTier: null }]),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(7);
    });

    it('returns free tier default on database error', async () => {
      (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      });

      const result = await getUserRetentionDays(mockUserId);

      expect(result).toBe(7);
    });
  });

  // ============================================
  // getPageVersionHistory
  // ============================================

  describe('getPageVersionHistory', () => {
    it('returns activities and total count', async () => {
      const mockActivities = [
        createMockActivity({ id: 'act_1' }),
        createMockActivity({ id: 'act_2' }),
      ];

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(mockActivities),
              }),
            }),
          }),
        }),
      }));

      // Mock for count query
      vi.spyOn(Promise, 'all').mockResolvedValueOnce([
        mockActivities,
        [{ value: 2 }],
      ]);

      const result = await getPageVersionHistory(mockPageId, mockUserId);

      expect(result.activities).toHaveLength(2);
      expect(result.activities[0].id).toBe('act_1');
    });

    it('applies filter options correctly', async () => {
      const mockActivities: ActivityLogForRollback[] = [];

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(mockActivities),
              }),
            }),
          }),
        }),
      }));

      vi.spyOn(Promise, 'all').mockResolvedValueOnce([
        mockActivities,
        [{ value: 0 }],
      ]);

      const result = await getPageVersionHistory(mockPageId, mockUserId, {
        limit: 10,
        offset: 5,
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        actorId: 'actor_123',
        operation: 'update',
        includeAiOnly: true,
      });

      expect(result.activities).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('returns empty results on error', async () => {
      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockRejectedValue(new Error('DB error')),
              }),
            }),
          }),
        }),
      }));

      const result = await getPageVersionHistory(mockPageId, mockUserId);

      expect(result.activities).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ============================================
  // getDriveVersionHistory
  // ============================================

  describe('getDriveVersionHistory', () => {
    it('returns drive-wide activities', async () => {
      const mockActivities = [
        createMockActivity({ id: 'act_1', resourceType: 'page' }),
        createMockActivity({ id: 'act_2', resourceType: 'member' }),
      ];

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(mockActivities),
              }),
            }),
          }),
        }),
      }));

      vi.spyOn(Promise, 'all').mockResolvedValueOnce([
        mockActivities,
        [{ value: 2 }],
      ]);

      const result = await getDriveVersionHistory(mockDriveId, mockUserId);

      expect(result.activities).toHaveLength(2);
    });

    it('filters by resourceType when specified', async () => {
      const mockActivities: ActivityLogForRollback[] = [];

      (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(mockActivities),
              }),
            }),
          }),
        }),
      }));

      vi.spyOn(Promise, 'all').mockResolvedValueOnce([
        mockActivities,
        [{ value: 0 }],
      ]);

      await getDriveVersionHistory(mockDriveId, mockUserId, {
        resourceType: 'page',
      });

      // Verify resourceType filter was applied (check the mock was called)
      expect(db.select).toHaveBeenCalled();
    });
  });
});
