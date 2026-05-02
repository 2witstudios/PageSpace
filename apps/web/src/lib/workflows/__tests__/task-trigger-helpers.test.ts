import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpdate, mockSet, mockWhere, mockReturning,
  mockFrom, mockSelect, mockSelectWhere,
  mockInsert,
  mockDelete, mockDeleteWhere,
  mockQueryPages,
  mockTransaction,
} = vi.hoisted(() => {
  // Top-level db chain (used outside transactions): select / update / delete.
  const mockReturning = vi.fn().mockResolvedValue([]);
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

  // Insert is only used inside transactions; the tx mock supplies its own
  // chain. These top-level mocks exist so a stray call would still be observable.
  const mockInsertReturning = vi.fn().mockResolvedValue([{ id: 'wf-new' }]);
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockQueryPages = { findFirst: vi.fn(), findMany: vi.fn() };

  // Default transaction implementation: callback receives a tx whose select /
  // insert / update / delete share the same mocks as the top-level db chain.
  const mockTransaction = vi.fn();

  return {
    mockUpdate, mockSet, mockWhere, mockReturning,
    mockFrom, mockSelect, mockSelectWhere,
    mockInsert,
    mockDelete, mockDeleteWhere,
    mockQueryPages, mockTransaction,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
    delete: mockDelete,
    query: { pages: mockQueryPages },
    transaction: mockTransaction,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: {
    id: 'id',
    name: 'name',
    triggerType: 'triggerType',
    isEnabled: 'isEnabled',
  },
}));
vi.mock('@pagespace/db/schema/task-triggers', () => ({
  taskTriggers: {
    id: 'id',
    workflowId: 'workflowId',
    taskItemId: 'taskItemId',
    triggerType: 'triggerType',
    isEnabled: 'isEnabled',
    nextRunAt: 'nextRunAt',
    lastFiredAt: 'lastFiredAt',
    lastFireError: 'lastFireError',
  },
}));

vi.mock('../workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
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
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import {
  syncTaskDueDateTrigger,
  cancelTaskDueDateTrigger,
  fireCompletionTrigger,
  disableTaskTriggers,
  createTaskTriggerWorkflow,
  recomputeTaskTriggerMetadata,
} from '../task-trigger-helpers';
import { executeWorkflow } from '../workflow-executor';
import { db } from '@pagespace/db/db';

// Helper: build a fresh tx-shaped mock that records insert/update/select calls.
// The real createTaskTriggerWorkflow runs all reads + writes inside one tx, so
// each test that exercises that path supplies its own chain. The transaction
// mock executes the callback synchronously with this tx.
function makeTxMock(opts: {
  existingTriggers?: unknown[];
  insertReturnRows?: { workflows?: unknown[]; taskTriggers?: unknown[] };
} = {}) {
  const txSelectWhere = vi.fn().mockResolvedValue(opts.existingTriggers ?? []);
  const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));
  const txSelect = vi.fn(() => ({ from: txSelectFrom }));

  const txInsertReturningWorkflows = vi.fn().mockResolvedValue(opts.insertReturnRows?.workflows ?? [{ id: 'wf-new' }]);
  const txInsertReturningTaskTriggers = vi.fn().mockResolvedValue(opts.insertReturnRows?.taskTriggers ?? [{ id: 'trg-new' }]);

  const insertCalls: { table: unknown; values: unknown }[] = [];
  let insertCount = 0;
  const txInsertValues = vi.fn((values: unknown) => {
    const calledFor = insertCalls[insertCalls.length - 1];
    if (calledFor) calledFor.values = values;
    return {
      // First insert in the helper is workflows, second is taskTriggers
      returning: insertCount === 1 ? txInsertReturningWorkflows : txInsertReturningTaskTriggers,
    };
  });
  const txInsert = vi.fn((table: unknown) => {
    insertCount++;
    insertCalls.push({ table, values: undefined });
    return { values: txInsertValues };
  });

  const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }));

  const tx = {
    select: txSelect,
    insert: txInsert,
    update: txUpdate,
  };

  return { tx, txInsert, txInsertValues, txUpdate, txUpdateSet, txSelect, insertCalls };
}

describe('task-trigger-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockImplementation(() => ({ set: mockSet }));
    mockSet.mockImplementation(() => ({ where: mockWhere }));
    mockWhere.mockImplementation(() => ({ returning: mockReturning }));
    mockReturning.mockResolvedValue([]);
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockFrom.mockImplementation(() => ({ where: mockSelectWhere }));
    mockSelectWhere.mockResolvedValue([]);
    mockDelete.mockImplementation(() => ({ where: mockDeleteWhere }));
    mockDeleteWhere.mockResolvedValue(undefined);

    // Default: transaction runs the callback against a fresh tx mock.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const { tx } = makeTxMock();
      return cb(tx);
    });
  });

  describe('syncTaskDueDateTrigger', () => {
    it('given a new due date, should update nextRunAt on matching enabled triggers', async () => {
      const dueDate = new Date('2026-05-01T00:00:00Z');
      await syncTaskDueDateTrigger('task-1', dueDate);

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: dueDate }));
    });

    it('given null due date, should disable trigger and clear nextRunAt', async () => {
      await syncTaskDueDateTrigger('task-1', null);

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastFireError: 'Due date cleared',
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

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastFireError: 'Task completed',
      }));
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockUpdate.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

      await expect(cancelTaskDueDateTrigger('task-1', 'reason')).resolves.toBeUndefined();
    });
  });

  describe('fireCompletionTrigger', () => {
    const mockTrigger = {
      id: 'trg-1',
      workflowId: 'wf-1',
      taskItemId: 'task-1',
      triggerType: 'completion',
      isEnabled: true,
      lastFiredAt: null,
      lastFireError: null,
    };

    const mockWorkflow = {
      id: 'wf-1',
      name: 'task-trigger-completion-task-1',
      driveId: 'drive-1',
      createdBy: 'user-1',
      agentPageId: 'agent-1',
      prompt: 'Do thing',
      contextPageIds: [],
      instructionPageId: null,
      timezone: 'UTC',
    };

    it('given a matching completion trigger, should claim it atomically and execute the linked workflow', async () => {
      // SELECT(taskTriggers) → trigger row
      // UPDATE(taskTriggers) claim → returns row (atomic confirmation)
      // SELECT(workflows) → workflow row
      mockFrom
        .mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([mockTrigger]) }))
        .mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([mockWorkflow]) }));
      mockReturning.mockResolvedValueOnce([mockTrigger]);

      const mockExecute = vi.mocked(executeWorkflow);
      mockExecute.mockResolvedValueOnce({ success: true, durationMs: 100 });

      await fireCompletionTrigger('task-1');

      expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
        workflowId: 'wf-1',
        agentPageId: 'agent-1',
        taskContext: { taskItemId: 'task-1', triggerType: 'completion' },
      }));
    });

    it('given the claim UPDATE returns 0 rows (race lost), should NOT execute the workflow', async () => {
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([mockTrigger]) }));
      mockReturning.mockResolvedValueOnce([]);

      const mockExecute = vi.mocked(executeWorkflow);

      await fireCompletionTrigger('task-1');

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('given no matching trigger, should return without executing', async () => {
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([]) }));

      const mockExecute = vi.mocked(executeWorkflow);

      await fireCompletionTrigger('task-1');

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('given trigger with non-null lastFiredAt (already fired), should NOT execute', async () => {
      const fired = { ...mockTrigger, lastFiredAt: new Date() };
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([fired]) }));

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
    it('given a task ID with active triggers, should disable triggers and delete linked workflow rows', async () => {
      // First select returns trigger rows with workflow IDs
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([
        { id: 'trg-1', workflowId: 'wf-1' },
        { id: 'trg-2', workflowId: 'wf-2' },
      ]) }));

      await disableTaskTriggers('task-1', 'Task deleted');

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
        isEnabled: false,
        lastFireError: 'Task deleted',
      }));
      expect(mockDelete).toHaveBeenCalled();
    });

    it('given no triggers for the task, should return without writing', async () => {
      mockFrom.mockImplementationOnce(() => ({ where: vi.fn().mockResolvedValueOnce([]) }));

      await disableTaskTriggers('task-1', 'Task deleted');

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('given a DB error, should not throw (internal try/catch)', async () => {
      mockSelect.mockImplementationOnce(() => { throw new Error('DB connection lost'); });

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
      mockQueryPages.findFirst.mockResolvedValue({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
      mockQueryPages.findMany.mockResolvedValue([]);
    });

    it('given valid params (no existing trigger), should insert workflows + task_triggers atomically and update task metadata', async () => {
      const captured = makeTxMock({ existingTriggers: [] });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(captured.tx));

      await createTaskTriggerWorkflow(validParams);

      // Two inserts (workflows then task_triggers)
      expect(captured.txInsert).toHaveBeenCalledTimes(2);
      const [workflowsInsert, taskTriggersInsert] = captured.insertCalls;
      expect((workflowsInsert.values as Record<string, unknown>).agentPageId).toBe('agent-1');
      expect((taskTriggersInsert.values as Record<string, unknown>).triggerType).toBe('due_date');
      expect((taskTriggersInsert.values as Record<string, unknown>).workflowId).toBe('wf-new');
      // Trailing metadata recompute
      expect(mockSelect).toHaveBeenCalled();
    });

    it('given triggerType completion, should write triggerType "completion" on task_triggers (no enum mapping)', async () => {
      const captured = makeTxMock({ existingTriggers: [] });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(captured.tx));

      await createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: { ...validParams.agentTrigger, triggerType: 'completion' },
      });

      const taskTriggersInsert = captured.insertCalls[1];
      expect((taskTriggersInsert.values as Record<string, unknown>).triggerType).toBe('completion');
    });

    it('given an existing trigger row (upsert), should update both workflows and task_triggers in place', async () => {
      const captured = makeTxMock({ existingTriggers: [{ workflowId: 'wf-old' }] });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(captured.tx));

      await createTaskTriggerWorkflow(validParams);

      // No inserts; both UPDATEs (workflows + task_triggers) ran
      expect(captured.txInsert).not.toHaveBeenCalled();
      expect(captured.txUpdate).toHaveBeenCalledTimes(2);
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
      mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
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
      mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', type: 'AI_CHAT', driveId: 'drive-1' });
      mockQueryPages.findMany.mockResolvedValueOnce([{ id: 'ctx-1' }]);

      await expect(createTaskTriggerWorkflow({
        ...validParams,
        agentTrigger: {
          ...validParams.agentTrigger,
          contextPageIds: ['ctx-1', 'ctx-2'],
        },
      })).rejects.toThrow('Some context pages were not found or are not in the same drive');
    });
  });

  describe('recomputeTaskTriggerMetadata', () => {
    it('writes triggerTypes and hasTrigger from the live task_triggers table, ignoring stale baseMetadata', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ triggerType: 'due_date' }]);
      const stale = { hasTrigger: true, triggerTypes: ['completion', 'due_date'], otherKey: 'preserved' };

      await recomputeTaskTriggerMetadata(db, 'task-1', stale);

      expect(mockSet).toHaveBeenCalledWith({
        metadata: {
          otherKey: 'preserved',
          triggerTypes: ['due_date'],
          hasTrigger: true,
        },
      });
    });

    it('clears hasTrigger when no enabled triggers remain', async () => {
      mockSelectWhere.mockResolvedValueOnce([]);

      await recomputeTaskTriggerMetadata(db, 'task-1', { hasTrigger: true, triggerTypes: ['completion'] });

      expect(mockSet).toHaveBeenCalledWith({
        metadata: {
          triggerTypes: [],
          hasTrigger: false,
        },
      });
    });

    it('handles null baseMetadata', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ triggerType: 'completion' }]);

      await recomputeTaskTriggerMetadata(db, 'task-1', null);

      expect(mockSet).toHaveBeenCalledWith({
        metadata: {
          triggerTypes: ['completion'],
          hasTrigger: true,
        },
      });
    });
  });
});
