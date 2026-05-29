import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const {
  mockInsert, mockInsertValues, mockReturning,
  mockCanActorAccessDrive,
  mockValidateAgentTrigger,
  mockValidateCron, mockValidateTimezone, mockGetNextRunDate, mockGetHumanReadableCron,
} = vi.hoisted(() => {
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'wf-1' }]);
  const mockInsertValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  return {
    mockInsert, mockInsertValues, mockReturning,
    mockCanActorAccessDrive: vi.fn(),
    mockValidateAgentTrigger: vi.fn(),
    mockValidateCron: vi.fn(),
    mockValidateTimezone: vi.fn(),
    mockGetNextRunDate: vi.fn(),
    mockGetHumanReadableCron: vi.fn(),
  };
});

vi.mock('@pagespace/db/db', () => ({ db: { insert: mockInsert } }));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id' } }));
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
  return { experimental_context: { userId: 'user-1', ...overrides } };
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
    const values = mockInsertValues.mock.calls[0][0];
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
    const values = mockInsertValues.mock.calls[0][0];
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
      workflowTools.create_workflow.execute!(validArgs, { experimental_context: {} }),
    ).rejects.toThrow(/authentication required/);
  });

  it('propagates agent-trigger validation failures', async () => {
    mockValidateAgentTrigger.mockRejectedValue(new Error('Agent page not found or not an AI agent'));
    await expect(workflowTools.create_workflow.execute!(validArgs, ctx())).rejects.toThrow(/not found or not an AI agent/);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
