import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const {
  mockInsert, mockInsertValues, mockReturning,
  mockSelect, mockSelectWhere,
  mockUpdate, mockUpdateSet,
  mockDelete,
  mockCanActorAccessDrive,
  mockValidateAgentTrigger,
  mockValidateCron, mockValidateTimezone, mockGetNextRunDate, mockGetHumanReadableCron,
} = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'wf-1' }]);
  const mockInsertValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
  return {
    mockInsert, mockInsertValues, mockReturning,
    mockSelect, mockSelectWhere,
    mockUpdate, mockUpdateSet,
    mockDelete,
    mockCanActorAccessDrive: vi.fn(),
    mockValidateAgentTrigger: vi.fn(),
    mockValidateCron: vi.fn(),
    mockValidateTimezone: vi.fn(),
    mockGetNextRunDate: vi.fn(),
    mockGetHumanReadableCron: vi.fn(),
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: { insert: mockInsert, select: mockSelect, update: mockUpdate, delete: mockDelete },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  and: vi.fn((...conds) => ({ op: 'and', conds })),
  isNotNull: vi.fn((field) => ({ op: 'isNotNull', field })),
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: {
    id: 'id', driveId: 'driveId', name: 'name', agentPageId: 'agentPageId',
    cronExpression: 'cronExpression', timezone: 'timezone', isEnabled: 'isEnabled', nextRunAt: 'nextRunAt',
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } },
}));
vi.mock('../actor-permissions', () => ({ canActorAccessDrive: mockCanActorAccessDrive }));
vi.mock('@/lib/workflows/agent-trigger-shared', () => ({
  validateAgentTrigger: mockValidateAgentTrigger,
  agentTriggerBaseSchema: z.object({
    agentPageId: z.string(),
    prompt: z.string().optional(),
    instructionPageId: z.string().nullable().optional(),
    contextPageIds: z.array(z.string()).optional(),
  }),
}));
vi.mock('@/lib/workflows/cron-utils', () => ({
  validateCronExpression: mockValidateCron,
  validateTimezone: mockValidateTimezone,
  getNextRunDate: mockGetNextRunDate,
  getHumanReadableCron: mockGetHumanReadableCron,
}));

import { workflowTools } from '../workflow-tools';

const NEXT_RUN = new Date('2026-06-01T09:00:00.000Z');

function ctx(overrides: Record<string, unknown> = {}) {
  return { toolCallId: '1', messages: [], experimental_context: { userId: 'user-1', ...overrides } };
}
const noAuthCtx = { toolCallId: '1', messages: [], experimental_context: {} };

function firstCallArg(mockFn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return mockFn.mock.calls[0][0] as Record<string, unknown>;
}

const validArgs = {
  driveId: 'drive-1',
  name: 'Daily summary',
  cronExpression: '0 9 * * 1-5',
  agentTrigger: { agentPageId: 'agent-1', prompt: 'summarize' },
};

describe('create_workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: 'wf-1' }]);
    mockCanActorAccessDrive.mockResolvedValue(true);
    mockValidateAgentTrigger.mockResolvedValue({ agentPageId: 'agent-1' });
    mockValidateCron.mockReturnValue({ valid: true });
    mockValidateTimezone.mockReturnValue({ valid: true });
    mockGetNextRunDate.mockReturnValue(NEXT_RUN);
    mockGetHumanReadableCron.mockReturnValue('At 09:00 AM, Monday through Friday');
  });

  it('creates an enabled cron workflow with a computed nextRunAt', async () => {
    const result = await workflowTools.create_workflow.execute!(validArgs, ctx());

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const values = firstCallArg(mockInsertValues);
    expect(values).toMatchObject({
      driveId: 'drive-1',
      createdBy: 'user-1',
      name: 'Daily summary',
      agentPageId: 'agent-1',
      prompt: 'summarize',
      cronExpression: '0 9 * * 1-5',
      triggerType: 'cron',
      isEnabled: true,
      nextRunAt: NEXT_RUN,
    });
    expect(result).toMatchObject({ success: true, workflowId: 'wf-1', nextRunAt: NEXT_RUN.toISOString() });
  });

  it('defaults prompt when only an instruction page is provided', async () => {
    await workflowTools.create_workflow.execute!(
      { ...validArgs, agentTrigger: { agentPageId: 'agent-1', instructionPageId: 'instr-1' } },
      ctx(),
    );
    const values = firstCallArg(mockInsertValues);
    expect(values.prompt).toBe('Execute instructions from linked page.');
    expect(values.instructionPageId).toBe('instr-1');
  });

  it('rejects a cron expression that is too frequent', async () => {
    mockValidateCron.mockReturnValue({ valid: false, error: 'Schedule is too frequent — minimum interval is 5 minutes' });
    await expect(workflowTools.create_workflow.execute!(validArgs, ctx())).rejects.toThrow(/too frequent/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects when the actor has no access to the drive', async () => {
    mockCanActorAccessDrive.mockResolvedValue(false);
    await expect(workflowTools.create_workflow.execute!(validArgs, ctx())).rejects.toThrow(/No access to the specified drive/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid timezone', async () => {
    mockValidateTimezone.mockReturnValue({ valid: false, error: 'Invalid timezone: Mars/Phobos' });
    await expect(
      workflowTools.create_workflow.execute!({ ...validArgs, timezone: 'Mars/Phobos' }, ctx()),
    ).rejects.toThrow(/Invalid timezone/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    await expect(
      workflowTools.create_workflow.execute!(validArgs, noAuthCtx),
    ).rejects.toThrow(/authentication required/);
  });

  it('propagates agent-trigger validation failures', async () => {
    mockValidateAgentTrigger.mockRejectedValue(new Error('Agent page not found or not an AI agent'));
    await expect(workflowTools.create_workflow.execute!(validArgs, ctx())).rejects.toThrow(/not found or not an AI agent/);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

const STANDALONE = {
  id: 'wf-1', driveId: 'drive-1', name: 'Daily summary', agentPageId: 'agent-1',
  prompt: 'summarize', instructionPageId: null, contextPageIds: [],
  cronExpression: '0 9 * * 1-5', timezone: 'UTC', isEnabled: true, nextRunAt: NEXT_RUN,
};
const TASK_BACKED = { ...STANDALONE, id: 'wf-2', cronExpression: null };

describe('list_workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanActorAccessDrive.mockResolvedValue(true);
    mockGetHumanReadableCron.mockReturnValue('At 09:00 AM, Monday through Friday');
    mockSelectWhere.mockResolvedValue([STANDALONE]);
  });

  it('lists standalone cron workflows in the drive', async () => {
    const result = (await workflowTools.list_workflow.execute!({ driveId: 'drive-1' }, ctx())) as {
      success: boolean;
      workflows: Array<Record<string, unknown>>;
    };
    expect(result.success).toBe(true);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({ workflowId: 'wf-1', cronExpression: '0 9 * * 1-5' });
  });

  it('rejects when the actor cannot access the drive', async () => {
    mockCanActorAccessDrive.mockResolvedValue(false);
    await expect(workflowTools.list_workflow.execute!({ driveId: 'drive-1' }, ctx())).rejects.toThrow(/No access/);
  });
});

describe('update_workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanActorAccessDrive.mockResolvedValue(true);
    mockValidateAgentTrigger.mockResolvedValue({ agentPageId: 'agent-1' });
    mockValidateCron.mockReturnValue({ valid: true });
    mockValidateTimezone.mockReturnValue({ valid: true });
    mockGetNextRunDate.mockReturnValue(NEXT_RUN);
    mockGetHumanReadableCron.mockReturnValue('At 10:00 AM, daily');
    mockSelectWhere.mockResolvedValue([STANDALONE]);
  });

  it('recomputes nextRunAt when the cron expression changes', async () => {
    await workflowTools.update_workflow.execute!({ workflowId: 'wf-1', cronExpression: '0 10 * * *' }, ctx());
    const setArg = firstCallArg(mockUpdateSet);
    expect(setArg.cronExpression).toBe('0 10 * * *');
    expect(setArg.nextRunAt).toBe(NEXT_RUN);
  });

  it('pauses a workflow without rescheduling', async () => {
    await workflowTools.update_workflow.execute!({ workflowId: 'wf-1', isEnabled: false }, ctx());
    const setArg = firstCallArg(mockUpdateSet);
    expect(setArg.isEnabled).toBe(false);
    expect(setArg.nextRunAt).toBeUndefined();
  });

  it('refuses to edit a task- or calendar-managed workflow', async () => {
    mockSelectWhere.mockResolvedValue([TASK_BACKED]);
    await expect(
      workflowTools.update_workflow.execute!({ workflowId: 'wf-2', name: 'x' }, ctx()),
    ).rejects.toThrow(/managed by a task or calendar event/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects when the workflow does not exist', async () => {
    mockSelectWhere.mockResolvedValue([]);
    await expect(
      workflowTools.update_workflow.execute!({ workflowId: 'missing', name: 'x' }, ctx()),
    ).rejects.toThrow(/not found/);
  });
});

describe('delete_workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanActorAccessDrive.mockResolvedValue(true);
    mockSelectWhere.mockResolvedValue([STANDALONE]);
  });

  it('deletes a standalone workflow', async () => {
    const result = await workflowTools.delete_workflow.execute!({ workflowId: 'wf-1' }, ctx());
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, workflowId: 'wf-1' });
  });

  it('refuses to delete a task- or calendar-managed workflow', async () => {
    mockSelectWhere.mockResolvedValue([TASK_BACKED]);
    await expect(
      workflowTools.delete_workflow.execute!({ workflowId: 'wf-2' }, ctx()),
    ).rejects.toThrow(/managed by a task or calendar event/);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
