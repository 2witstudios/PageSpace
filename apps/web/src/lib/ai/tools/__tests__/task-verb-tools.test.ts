import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock database and dependencies (mirrors task-management-tools.test.ts so the
// shared task-helpers exercised by the new verb tools resolve against the same
// in-memory db mock — no real DB).
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    transaction: vi.fn(),
    query: {
      taskItems: { findFirst: vi.fn(), findMany: vi.fn() },
      taskLists: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', parentId: 'parentId', revision: 'revision' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: { id: 'id', pageId: 'pageId', userId: 'userId' },
  taskItems: { id: 'id', position: 'position' },
  taskStatusConfigs: { taskListId: 'taskListId', position: 'position' },
  taskAssignees: { taskId: 'taskId' },
}));

const { deferredTriggerMock } = vi.hoisted(() => ({
  deferredTriggerMock: vi.fn(),
}));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn().mockResolvedValue({
    pageId: 'p',
    driveId: 'd',
    nextRevision: 1,
    deferredTrigger: deferredTriggerMock,
  }),
  PageRevisionMismatchError: class PageRevisionMismatchError extends Error {
    currentRevision = 0;
    expectedRevision?: number;
  },
}));

vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  createTaskTriggerWorkflow: vi.fn(),
  syncTaskDueDateTrigger: vi.fn(),
  cancelTaskDueDateTrigger: vi.fn(),
  fireCompletionTrigger: vi.fn(),
  disableTaskTriggers: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn(),
  canUserViewPage: vi.fn(),
  getUserDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logPageActivity: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@test.com' }),
}));

vi.mock('@pagespace/lib/content/page-types.config', () => ({
  getDefaultContent: vi.fn(() => ''),
  getCreatablePageTypes: vi.fn(() => ['DOCUMENT', 'FOLDER', 'TASK_LIST']),
}));
vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { DOCUMENT: 'DOCUMENT' },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@/lib/tasks/completion-guard', () => ({
  assertSubTasksComplete: vi.fn().mockResolvedValue(undefined),
  SubtasksIncompleteError: class SubtasksIncompleteError extends Error {
    readonly code = 'SUBTASKS_INCOMPLETE' as const;
    constructor(public readonly pending: number, public readonly total: number) {
      super(`Complete all sub-tasks first (${pending} of ${total} remaining)`);
      this.name = 'SubtasksIncompleteError';
    }
  },
}));

import { taskManagementTools } from '../task-management-tools';
import { db } from '@pagespace/db/db';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { broadcastTaskEvent } from '@/lib/websocket';
import type { ToolExecutionContext } from '../../core/types';

const mockDb = vi.mocked(db);
const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockBroadcastTaskEvent = vi.mocked(broadcastTaskEvent);

const context = {
  toolCallId: '1',
  messages: [],
  experimental_context: { userId: 'user-123' } as ToolExecutionContext,
};

describe('task verb tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default db.select chain (supports both innerJoin and direct .where paths).
    mockDb.select = vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([]),
        })),
      })),
    })) as unknown as typeof mockDb.select;
  });

  describe('create_task', () => {
    it('requires pageId and title (rejects missing title)', () => {
      const schema = taskManagementTools.create_task.inputSchema as z.ZodTypeAny;
      expect(() => schema.parse({ pageId: 'page-1' })).toThrow();
      // pageId + title parses cleanly
      expect(schema.parse({ pageId: 'page-1', title: 'Do the thing' })).toMatchObject({
        pageId: 'page-1',
        title: 'Do the thing',
      });
    });

    it('creates a task and its linked TASK_LIST page', async () => {
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'page-1',
        userId: 'user-123',
        title: 'My Tasks',
        description: null,
        status: 'pending',
      });
      mockDb.query.taskStatusConfigs.findMany = vi.fn().mockResolvedValue([]);
      mockDb.query.taskItems.findMany = vi.fn().mockResolvedValue([]);
      mockCanUserEditPage.mockResolvedValue(true);

      let capturedPageInsert: Record<string, unknown> | null = null;
      mockDb.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 1) capturedPageInsert = vals;
              return {
                returning: vi.fn().mockResolvedValue(
                  insertCallCount === 1
                    ? [{ id: 'new-page', title: 'New Task', type: 'TASK_LIST' }]
                    : [{ id: 'new-task', pageId: 'new-page', status: 'pending', priority: 'medium', position: 0, dueDate: null, assigneeId: null, assigneeAgentId: null, metadata: {}, completedAt: null }]
                ),
              };
            }),
          })),
        };
        return cb(tx);
      }) as unknown as typeof mockDb.transaction;

      // pages.findFirst: taskListPage, lastChildPage(null), then driveId lookup.
      mockDb.query.pages.findFirst = vi.fn()
        .mockResolvedValueOnce({ id: 'page-1', type: 'TASK_LIST', title: 'My Task List', driveId: 'drive-1' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ driveId: 'drive-1' });

      const result = await taskManagementTools.create_task.execute!(
        { pageId: 'page-1', title: 'New Task' },
        context
      );

      expect(capturedPageInsert).toMatchObject({ type: 'TASK_LIST', content: '' });
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          action: 'created',
          task: expect.objectContaining({ id: 'new-task', title: 'New Task' }),
        }),
      );
    });

    it('rejects a blank/whitespace title', async () => {
      await expect(
        taskManagementTools.create_task.execute!(
          { pageId: 'page-1', title: '   ' },
          context
        )
      ).rejects.toThrow('Title cannot be empty');
    });

    it('rejects when the target page is not a TASK_LIST', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        type: 'DOCUMENT',
        title: 'Regular Doc',
        driveId: 'drive-1',
      });
      mockCanUserEditPage.mockResolvedValue(true);

      await expect(
        taskManagementTools.create_task.execute!(
          { pageId: 'page-1', title: 'New Task' },
          context
        )
      ).rejects.toThrow('Page must be a TASK_LIST page to add tasks');
    });
  });

  describe('delete_task', () => {
    it('requires a taskId', () => {
      const schema = taskManagementTools.delete_task.inputSchema as z.ZodTypeAny;
      expect(() => schema.parse({})).toThrow();
      expect(schema.parse({ taskId: 'task-1' })).toMatchObject({ taskId: 'task-1' });
    });

    it('hard-deletes the task and trashes its linked page', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        pageId: 'doc-page-1',
        page: { title: 'Old Task', parentId: 'task-list-page-1' },
      });
      mockDb.query.taskItems.findMany = vi.fn().mockResolvedValue([]);
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'task-list-page-1',
        userId: 'user-123',
        title: 'My Tasks',
        description: null,
        status: 'pending',
      });
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({ driveId: 'drive-1' });
      mockCanUserEditPage.mockResolvedValue(true);

      const deleteCalls: unknown[] = [];
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ revision: 5 }]),
        delete: vi.fn(() => ({
          where: vi.fn().mockImplementation((arg: unknown) => {
            deleteCalls.push(arg);
            return Promise.resolve();
          }),
        })),
      };
      mockDb.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)) as unknown as typeof mockDb.transaction;

      const result = await taskManagementTools.delete_task.execute!(
        { taskId: 'task-1' },
        context
      );

      const { applyPageMutation } = await import('@/services/api/page-mutation-service');
      const { disableTaskTriggers } = await import('@/lib/workflows/task-trigger-helpers');

      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'doc-page-1',
          operation: 'trash',
          expectedRevision: 5,
        }),
      );
      expect(disableTaskTriggers).toHaveBeenCalledWith('task-1', expect.any(String));
      expect(deferredTriggerMock).toHaveBeenCalled();
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          action: 'deleted',
          task: expect.objectContaining({ id: 'task-1', pageId: 'doc-page-1' }),
          taskList: expect.objectContaining({ id: 'list-1' }),
          tasks: expect.any(Array),
        }),
      );
    });

    it('rejects when the actor lacks edit permission', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        pageId: 'doc-page-1',
        page: { title: 'Old Task', parentId: 'task-list-page-1' },
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'task-list-page-1',
        userId: 'other-user',
      });
      mockCanUserEditPage.mockResolvedValue(false);

      await expect(
        taskManagementTools.delete_task.execute!(
          { taskId: 'task-1' },
          context
        )
      ).rejects.toThrow('You do not have permission to update tasks on this page');
    });
  });

  describe('reorder_task', () => {
    it('requires taskId and position', () => {
      const schema = taskManagementTools.reorder_task.inputSchema as z.ZodTypeAny;
      expect(() => schema.parse({ taskId: 'task-1' })).toThrow();
      expect(() => schema.parse({ position: 2 })).toThrow();
      expect(schema.parse({ taskId: 'task-1', position: 2 })).toMatchObject({ taskId: 'task-1', position: 2 });
    });

    it('moves the task to a midpoint pages.position between its new neighbours (#2143)', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-2',
        pageId: 'doc-2',
        position: 1,
        status: 'pending',
        priority: 'medium',
        assigneeId: null,
        assigneeAgentId: null,
        dueDate: null,
        completedAt: null,
        page: { title: 'Middle Task', parentId: 'task-list-page-1' },
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'task-list-page-1',
        userId: 'user-123',
        title: 'My Tasks',
        description: null,
        status: 'pending',
      });
      mockDb.query.taskItems.findMany = vi.fn().mockResolvedValue([]);
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({ driveId: 'drive-1' });
      mockCanUserEditPage.mockResolvedValue(true);

      const peerRows = [
        { id: 'task-1', position: 0 },
        { id: 'task-2', position: 1 },
        { id: 'task-3', position: 2 },
        { id: 'task-4', position: 3 },
      ];
      mockDb.select = vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(peerRows),
      })) as unknown as typeof mockDb.select;

      const reorderTxMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(undefined),
            })),
          })),
        };
        return cb(tx);
      });
      mockDb.transaction = reorderTxMock as unknown as typeof mockDb.transaction;

      const result = await taskManagementTools.reorder_task.execute!(
        { taskId: 'task-2', position: 3 },
        context
      );

      expect(reorderTxMock).toHaveBeenCalled();
      // Reorders must broadcast so collaborators/other clients see the move.
      expect(mockBroadcastTaskEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_updated', taskId: 'task-2' }),
      );
      // Slot 3 sits between task-3 (position 2) and task-4 (position 3) once
      // task-2 is excluded from its own peer list — the midpoint is 2.5, not a
      // re-densified integer.
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          action: 'updated',
          task: expect.objectContaining({ id: 'task-2', position: 2.5 }),
        }),
      );
    });

    it('rejects when the task does not exist', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue(null);

      await expect(
        taskManagementTools.reorder_task.execute!(
          { taskId: 'missing', position: 0 },
          context
        )
      ).rejects.toThrow('Task not found');
    });
  });
});
