import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    transaction: vi.fn(),
    query: {
      taskItems: { findFirst: vi.fn() },
      taskLists: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
    },
  },
  taskLists: { id: 'id', pageId: 'pageId', userId: 'userId' },
  taskItems: { id: 'id', taskListId: 'taskListId' },
  pages: { id: 'id', parentId: 'parentId' },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  getDefaultContent: vi.fn(() => ''),
  PageType: { DOCUMENT: 'DOCUMENT' },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

import { taskManagementTools } from '../task-management-tools';
import { db } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockCanUserEditPage = vi.mocked(canUserEditPage);

describe('task-management-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('update_task', () => {
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

  });
});
