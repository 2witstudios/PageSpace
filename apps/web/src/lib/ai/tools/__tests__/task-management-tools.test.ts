import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock database and dependencies
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
  taskItems: { id: 'id', taskListId: 'taskListId', position: 'position' },
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

import { taskManagementTools } from '../task-management-tools';
import { db } from '@pagespace/db/db';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockCanUserEditPage = vi.mocked(canUserEditPage);

describe('task-management-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('update_task', () => {
    it('normalizes incomplete agentTrigger input to undefined', () => {
      const parsed = (taskManagementTools.update_task.inputSchema as z.ZodTypeAny).parse({
        taskId: 'task-1',
        agentTrigger: {
          agentPageId: 'agent-1',
        },
      }) as {
        agentTrigger?: unknown;
      };

      expect(parsed.agentTrigger).toBeUndefined();
    });

    it('has correct tool definition', () => {
      expect(taskManagementTools.update_task).toBeDefined();
      expect(taskManagementTools.update_task.description).toContain('task');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'task-1', status: 'completed' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('requires taskId or pageId', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { status: 'completed' },
          context
        )
      ).rejects.toThrow('Either taskId (to update) or pageId (to create) must be provided');
    });

    it('requires title when creating new task', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { pageId: 'page-1' },
          context
        )
      ).rejects.toThrow('Title is required when creating a new task');
    });

    it('throws error when task not found for update', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'non-existent', status: 'completed' },
          context
        )
      ).rejects.toThrow('Task not found');
    });

    it('throws error when task list not found', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        taskListId: 'list-1',
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'task-1', status: 'completed' },
          context
        )
      ).rejects.toThrow('Task list not found');
    });

    it('throws error when user lacks permission on page-linked task', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        taskListId: 'list-1',
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'page-1',
        userId: 'other-user',
      });
      mockCanUserEditPage.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'task-1', status: 'completed' },
          context
        )
      ).rejects.toThrow('You do not have permission to update tasks on this page');
    });

    it('throws error when user is not owner of personal task list', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        taskListId: 'list-1',
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: null, // Personal task list, not page-linked
        userId: 'other-user',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'task-1', status: 'completed' },
          context
        )
      ).rejects.toThrow('You do not have permission to update this task');
    });

    it('throws error when page is not TASK_LIST type', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'page-1',
        type: 'DOCUMENT',
        title: 'Regular Doc',
        driveId: 'drive-1',
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { pageId: 'page-1', title: 'New Task' },
          context
        )
      ).rejects.toThrow('Page must be a TASK_LIST page to add tasks');
    });

    describe('delete branch', () => {
      it('hard-deletes task and trashes linked DOCUMENT page when delete: true', async () => {
        mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
          id: 'task-1',
          taskListId: 'list-1',
          pageId: 'doc-page-1',
          title: 'Old Task',
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

        const tx = {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ revision: 5 }]),
          delete: vi.fn().mockReturnThis(),
        };
        // Make .where on delete chain return a thenable that resolves
        const deleteCalls: unknown[] = [];
        tx.delete = vi.fn(() => {
          const chain = {
            where: vi.fn().mockImplementation((arg: unknown) => {
              deleteCalls.push(arg);
              return Promise.resolve();
            }),
          };
          return chain as unknown as typeof tx;
        });
        const transactionMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
        mockDb.transaction = transactionMock as unknown as typeof mockDb.transaction;

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        const result = await taskManagementTools.update_task.execute!(
          { taskId: 'task-1', delete: true },
          context
        );

        const { applyPageMutation } = await import('@/services/api/page-mutation-service');
        const { disableTaskTriggers } = await import('@/lib/workflows/task-trigger-helpers');

        expect(applyPageMutation).toHaveBeenCalledWith(
          expect.objectContaining({
            pageId: 'doc-page-1',
            operation: 'trash',
            updates: expect.objectContaining({ isTrashed: true }),
            expectedRevision: 5,
          }),
        );
        expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
        expect(disableTaskTriggers).toHaveBeenCalledWith('task-1', expect.any(String));
        // Deferred workflow trigger from applyPageMutation must run after the tx commits
        // so downstream automation tied to page-trash activity fires.
        expect(deferredTriggerMock).toHaveBeenCalled();
        expect(result).toEqual(
          expect.objectContaining({
            success: true,
            action: 'deleted',
            task: expect.objectContaining({ id: 'task-1', pageId: 'doc-page-1' }),
            // Refreshed list payload so client UIs (TasksDropdown via
            // useAggregatedTasks) drop the deleted task immediately.
            tasks: expect.any(Array),
            taskList: expect.objectContaining({ id: 'list-1' }),
          }),
        );
      });

      it('ignores field updates when delete: true is also passed', async () => {
        mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
          id: 'task-1',
          taskListId: 'list-1',
          pageId: 'doc-page-1',
          title: 'Old Task',
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

        const updateMock = vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'task-1', title: 'NEW' }]),
            }),
          }),
        });
        const tx = {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ revision: 1 }]),
          delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
          update: updateMock,
        };
        mockDb.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
          cb(tx)
        ) as unknown as typeof mockDb.transaction;

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        const result = await taskManagementTools.update_task.execute!(
          { taskId: 'task-1', delete: true, title: 'Should Be Ignored', status: 'completed' },
          context
        );

        expect(updateMock).not.toHaveBeenCalled();
        expect((result as { action: string }).action).toBe('deleted');
      });

      it('rejects delete when no taskId is provided', async () => {
        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await expect(
          taskManagementTools.update_task.execute!(
            { delete: true, pageId: 'page-1' },
            context
          )
        ).rejects.toThrow('delete requires a taskId');
      });
    });

    describe('reorder branch (position on existing task)', () => {
      it('densifies peer positions when position is provided alongside taskId', async () => {
        mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
          id: 'task-2',
          taskListId: 'list-1',
          pageId: 'doc-2',
          title: 'Middle Task',
        });
        mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
          id: 'list-1',
          pageId: 'task-list-page-1',
          userId: 'user-123',
        });
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({ driveId: 'drive-1' });
        mockCanUserEditPage.mockResolvedValue(true);

        // First db.select for the field-update transaction's siblings (status not provided, so won't be hit).
        // Second db.select for reorder peer fetch.
        const peerRows = [
          { id: 'task-1', position: 0 },
          { id: 'task-2', position: 1 },
          { id: 'task-3', position: 2 },
          { id: 'task-4', position: 3 },
        ];
        const selectCalls: unknown[] = [];
        const dbSelectMock = vi.fn(() => {
          const chain = {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn(() => {
              selectCalls.push('orderBy');
              return Promise.resolve(peerRows);
            }),
          };
          return chain;
        });
        mockDb.select = dbSelectMock as unknown as typeof mockDb.select;

        // Field-update transaction returns the updated task
        const fieldUpdateMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn(() => ({
              set: vi.fn(() => ({
                where: vi.fn(() => ({
                  returning: vi.fn().mockResolvedValue([
                    { id: 'task-2', title: 'Middle Task', position: 1 },
                  ]),
                })),
              })),
            })),
            delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
            insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
          };
          return cb(tx);
        });

        // Reorder transaction collects position writes
        const positionWrites: Array<{ id: string; position: number }> = [];
        const reorderTxMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn(() => {
              let pendingPosition: number | undefined;
              const chain = {
                set: vi.fn((vals: { position: number }) => {
                  pendingPosition = vals.position;
                  return chain;
                }),
                where: vi.fn(() => {
                  const idArg = (chain as unknown as { _id?: string })._id;
                  positionWrites.push({ id: idArg ?? '', position: pendingPosition ?? -1 });
                  return Promise.resolve();
                }),
              };
              return chain;
            }),
          };
          return cb(tx);
        });

        let txCallCount = 0;
        mockDb.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          txCallCount += 1;
          if (txCallCount === 1) return fieldUpdateMock(cb);
          return reorderTxMock(cb);
        }) as unknown as typeof mockDb.transaction;

        // Mock db.query.taskItems.findMany used by the response builder at the end
        mockDb.query.taskItems.findMany = vi.fn().mockResolvedValue([]);

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        const result = await taskManagementTools.update_task.execute!(
          { taskId: 'task-2', position: 3 },
          context
        );

        // Expect the reorder transaction to have been called
        expect(reorderTxMock).toHaveBeenCalled();
        // Result should reflect the clamped/densified position
        expect((result as { task: { position: number } }).task.position).toBe(3);
      });
    });

  });
});
