import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpdate, mockSet, mockWhere, mockReturning, mockFrom, mockSelect, mockInsert, mockValues, mockOnConflict, mockQueryPages } = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([]);
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockFrom = vi.fn().mockReturnThis();
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockOnConflict = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflict }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockQueryPages = { findFirst: vi.fn(), findMany: vi.fn() };
  return { mockUpdate, mockSet, mockWhere, mockReturning, mockFrom, mockSelect, mockInsert, mockValues, mockOnConflict, mockQueryPages };
});

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
    query: { pages: mockQueryPages },
  },
  workflows: {
    id: 'id',
    taskItemId: 'taskItemId',
    triggerType: 'triggerType',
    isEnabled: 'isEnabled',
    lastRunStatus: 'lastRunStatus',
    lastRunAt: 'lastRunAt',
    lastRunError: 'lastRunError',
    lastRunDurationMs: 'lastRunDurationMs',
    nextRunAt: 'nextRunAt',
  },
  taskItems: { id: 'id' },
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

import {
  syncTaskDueDateTrigger,
  cancelTaskDueDateTrigger,
  fireCompletionTrigger,
  disableTaskTriggers,
  createTaskTriggerWorkflow,
} from '../task-trigger-helpers';
import { executeWorkflow } from '../workflow-executor';
import { db } from '@pagespace/db';

describe('task-trigger-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chain defaults
    mockUpdate.mockImplementation(() => ({ set: mockSet }));
    mockSet.mockImplementation(() => ({ where: mockWhere }));
    mockWhere.mockImplementation(() => ({ returning: mockReturning }));
    mockReturning.mockResolvedValue([]);
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockFrom.mockImplementation(() => ({ where: mockWhere }));
  });

  describe('syncTaskDueDateTrigger', () => {
    it('given a new due date, should update nextRunAt on matching enabled never_run triggers', async () => {
      const dueDate = new Date('2026-05-01T00:00:00Z');
      await syncTaskDueDateTrigger('task-1', dueDate);

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: dueDate }));
    });

    it('given null due date, should disable trigger and clear nextRunAt', async () => {
      await syncTaskDueDateTrigger('task-1', null);

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastRunError: 'Due date cleared',
        nextRunAt: null,
      }));
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockUpdate.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

      await expect(syncTaskDueDateTrigger('task-1', new Date())).resolves.toBeUndefined();
    });
  });

  describe('cancelTaskDueDateTrigger', () => {
    it('given a task ID and reason, should disable the trigger with the reason', async () => {
      await cancelTaskDueDateTrigger('task-1', 'Task completed');

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastRunError: 'Task completed',
      }));
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockUpdate.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

      await expect(cancelTaskDueDateTrigger('task-1', 'reason')).resolves.toBeUndefined();
    });
  });

  describe('fireCompletionTrigger', () => {
    const mockWorkflow = {
      id: 'wf-1',
      taskItemId: 'task-1',
      triggerType: 'task_completion',
      isEnabled: true,
      lastRunStatus: 'never_run',
    };

    it('given a matching completion workflow, should claim it atomically and execute', async () => {
      // SELECT returns the workflow
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([mockWorkflow]) }));
      // UPDATE claim returns the claimed row (atomic confirmation)
      mockReturning.mockResolvedValueOnce([mockWorkflow]);

      const mockExecute = vi.mocked(executeWorkflow);
      mockExecute.mockResolvedValueOnce({ success: true, durationMs: 100 });

      await fireCompletionTrigger('task-1');

      expect(mockExecute).toHaveBeenCalledWith(mockWorkflow);
    });

    it('given the claim UPDATE returns 0 rows (race lost), should NOT execute the workflow', async () => {
      // SELECT returns the workflow
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([mockWorkflow]) }));
      // UPDATE claim returns empty (another caller already claimed it)
      mockReturning.mockResolvedValueOnce([]);

      const mockExecute = vi.mocked(executeWorkflow);

      await fireCompletionTrigger('task-1');

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('given no matching workflow, should return without executing', async () => {
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([]) }));

      const mockExecute = vi.mocked(executeWorkflow);

      await fireCompletionTrigger('task-1');

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockSelect.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

      await expect(fireCompletionTrigger('task-1')).resolves.toBeUndefined();
    });
  });

  describe('disableTaskTriggers', () => {
    it('given a task ID and reason, should disable all enabled triggers for that task', async () => {
      await disableTaskTriggers('task-1', 'Task deleted');

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastRunError: 'Task deleted',
      }));
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockUpdate.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

      await expect(disableTaskTriggers('task-1', 'reason')).resolves.toBeUndefined();
    });
  });

  describe('createTaskTriggerWorkflow', () => {
    const validParams = {
      database: db as typeof db,
      driveId: 'drive-1',
      userId: 'user-1',
      taskId: 'task-1',
      taskMetadata: null,
      agentTrigger: {
        agentPageId: 'agent-1',
        prompt: 'Do the thing',
        triggerType: 'due_date' as const,
      },
      dueDate: new Date('2026-05-01T00:00:00Z'),
      timezone: 'UTC',
    };

    beforeEach(() => {
      // Agent page exists and is in same drive
      mockQueryPages.findFirst.mockResolvedValue({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
      // Context pages (none by default)
      mockQueryPages.findMany.mockResolvedValue([]);
    });

    it('given valid params, should insert a workflow and update task metadata', async () => {
      await createTaskTriggerWorkflow(validParams);

      expect(mockInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
        driveId: 'drive-1',
        createdBy: 'user-1',
        agentPageId: 'agent-1',
        triggerType: 'task_due_date',
        taskItemId: 'task-1',
        isEnabled: true,
      }));
    });

    it('given triggerType completion, should set triggerType to task_completion', async () => {
      await createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: { ...validParams.agentTrigger, triggerType: 'completion' },
      });

      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
        triggerType: 'task_completion',
      }));
    });

    it('given due_date trigger without dueDate, should throw', async () => {
      await expect(createTaskTriggerWorkflow({
        ...validParams,
        dueDate: null,
      })).rejects.toThrow('Due date is required for due_date triggers');
    });

    it('given no prompt and no instructionPageId, should throw', async () => {
      await expect(createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: { agentPageId: 'agent-1', triggerType: 'due_date' },
      })).rejects.toThrow('Agent trigger needs either a prompt or instructionPageId');
    });

    it('given agent page not found, should throw', async () => {
      mockQueryPages.findFirst.mockResolvedValueOnce(null);

      await expect(createTaskTriggerWorkflow(validParams))
        .rejects.toThrow('Agent trigger target not found or not an AI agent');
    });

    it('given agent page in different drive, should throw', async () => {
      mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', type: 'AI_CHAT', driveId: 'other-drive' });

      await expect(createTaskTriggerWorkflow(validParams))
        .rejects.toThrow('Agent must be in the same drive as the task list');
    });

    it('given invalid instructionPageId, should throw', async () => {
      // findFirst: agent page OK
      mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
      // findFirst: instruction page not found
      mockQueryPages.findFirst.mockResolvedValueOnce(null);

      await expect(createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: {
          ...validParams.agentTrigger,
          instructionPageId: 'bad-page-id',
        },
      })).rejects.toThrow('Instruction page not found or not in the same drive');
    });

    it('given contextPageIds with pages not in the same drive, should throw', async () => {
      // findFirst for agent page succeeds
      mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
      // findMany returns fewer pages than requested (some not in same drive)
      mockQueryPages.findMany.mockResolvedValueOnce([{ id: 'ctx-1' }]);

      await expect(createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: {
          ...validParams.agentTrigger,
          contextPageIds: ['ctx-1', 'ctx-2'],
        },
      })).rejects.toThrow('Some context pages were not found or are not in the same drive');
    });

    it('given duplicate trigger (onConflictDoUpdate), should upsert instead of throwing', async () => {
      await createTaskTriggerWorkflow(validParams);

      expect(mockOnConflict).toHaveBeenCalled();
    });
  });
});
