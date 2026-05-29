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
import type { ToolExecutionContext } from '../../core';
import { assertSubTasksComplete, SubtasksIncompleteError } from '@/lib/tasks/completion-guard';

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

    it('rejects when taskId is missing, pointing callers to create_task', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { status: 'completed' },
          context
        )
      ).rejects.toThrow('taskId is required to update a task. To create a new task, use create_task.');
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

    it('rejects empty/whitespace title on update', async () => {
      mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
        id: 'task-1',
        taskListId: 'list-1',
        pageId: 'page-1',
        page: { title: 'Existing' },
      });
      mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
        id: 'list-1',
        pageId: 'tasklist-page-1',
        userId: 'user-123',
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockDb.query.taskStatusConfigs.findMany = vi.fn().mockResolvedValue([]);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        taskManagementTools.update_task.execute!(
          { taskId: 'task-1', title: '   ' },
          context
        )
      ).rejects.toThrow('Title cannot be empty');
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

    describe('completion guard', () => {
      it('returns structured failure when completing a task with incomplete sub-tasks', async () => {
        mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
          id: 'task-1',
          taskListId: 'list-1',
          pageId: 'task-page-1',
          completedAt: null,
        });
        mockDb.query.taskLists.findFirst = vi.fn().mockResolvedValue({
          id: 'list-1',
          pageId: 'tasklist-page-1',
          userId: 'user-123',
        });
        mockCanUserEditPage.mockResolvedValue(true);
        mockDb.query.taskStatusConfigs.findMany = vi.fn().mockResolvedValue([]);
        vi.mocked(assertSubTasksComplete).mockRejectedValueOnce(
          new SubtasksIncompleteError(2, 3)
        );

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        const result = await taskManagementTools.update_task.execute!(
          { taskId: 'task-1', status: 'completed' },
          context
        );
        expect(result).toMatchObject({ success: false, pending: 2, total: 3 });
      });
    });

    describe('field update', () => {
      it('updates a field and returns the refreshed task list', async () => {
        mockDb.query.taskItems.findFirst = vi.fn().mockResolvedValue({
          id: 'task-1',
          pageId: 'doc-page-1',
          status: 'pending',
          priority: 'medium',
          assigneeId: null,
          assigneeAgentId: null,
          dueDate: null,
          completedAt: null,
          metadata: null,
          page: { title: 'My Task', parentId: 'task-list-page-1' },
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
        mockDb.query.taskStatusConfigs.findMany = vi.fn().mockResolvedValue([]);
        mockCanUserEditPage.mockResolvedValue(true);

        mockDb.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            update: vi.fn(() => ({
              set: vi.fn(() => ({
                where: vi.fn(() => ({
                  returning: vi.fn().mockResolvedValue([
                    { id: 'task-1', pageId: 'doc-page-1', status: 'pending', priority: 'high', position: 0, dueDate: null, assigneeId: null, assigneeAgentId: null, completedAt: null },
                  ]),
                })),
              })),
            })),
            delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
            insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
          };
          return cb(tx);
        }) as unknown as typeof mockDb.transaction;

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        const result = await taskManagementTools.update_task.execute!(
          { taskId: 'task-1', priority: 'high' },
          context
        );

        expect(result).toEqual(
          expect.objectContaining({
            success: true,
            action: 'updated',
            task: expect.objectContaining({ id: 'task-1', priority: 'high' }),
            taskList: expect.objectContaining({ id: 'list-1' }),
            tasks: expect.any(Array),
          }),
        );
      });
    });

  });
});
