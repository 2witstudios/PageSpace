import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const {
  mockDbQuery,
  mockInsert, _mockInsertValues, _mockInsertReturning,
  mockUpdate, _mockUpdateSet, _mockUpdateWhere,
  mockSelect, _mockSelectFrom, _mockSelectWhere,
  mockDbTransaction,
  mockUpsertCalendarTriggerWorkflow,
  mockUpsertCalendarTriggerWorkflowInTx,
  mockRemoveCalendarTrigger,
  mockValidateCalendarAgentTrigger,
  mockCreateTaskTriggerWorkflow,
  mockRecomputeTaskTriggerMetadata,
  mockIsUserDriveMember,
  mockCanActorEditPage,
  mockCanActorManageDrive,
  mockDriveDeniedByAppToken,
  mockBroadcastCalendarEvent,
  mockBroadcastTaskEvent,
} = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([{ id: 'event-1' }]);
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  return {
    mockDbQuery: vi.fn(),
    mockInsert, _mockInsertValues: mockInsertValues, _mockInsertReturning: mockInsertReturning,
    mockUpdate, _mockUpdateSet: mockUpdateSet, _mockUpdateWhere: mockUpdateWhere,
    mockSelect, _mockSelectFrom: mockSelectFrom, _mockSelectWhere: mockSelectWhere,
    mockDbTransaction: vi.fn(),
    mockUpsertCalendarTriggerWorkflow: vi.fn(),
    mockUpsertCalendarTriggerWorkflowInTx: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'ct-1' }),
    mockRemoveCalendarTrigger: vi.fn(),
    mockValidateCalendarAgentTrigger: vi.fn(),
    mockCreateTaskTriggerWorkflow: vi.fn(),
    mockRecomputeTaskTriggerMetadata: vi.fn(),
    mockIsUserDriveMember: vi.fn(),
    mockCanActorEditPage: vi.fn(),
    mockCanActorManageDrive: vi.fn(),
    mockDriveDeniedByAppToken: vi.fn().mockResolvedValue(false),
    mockBroadcastCalendarEvent: vi.fn(),
    mockBroadcastTaskEvent: vi.fn(),
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { calendarEvents: { findFirst: mockDbQuery }, taskItems: { findFirst: mockDbQuery }, pages: { findFirst: mockDbQuery }, taskLists: { findFirst: mockDbQuery } },
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
    transaction: mockDbTransaction,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/calendar', () => ({ calendarEvents: {}, eventAttendees: {} }));
vi.mock('@pagespace/db/schema/tasks', () => ({ taskItems: {}, taskLists: {} }));
vi.mock('@pagespace/db/schema/task-triggers', () => ({ taskTriggers: {} }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
}));
vi.mock('@/lib/workflows/agent-trigger-shared', () => ({
  agentTriggerBaseSchema: z.object({
    agentPageId: z.string(),
    prompt: z.string().optional(),
    instructionPageId: z.string().nullable().optional(),
    contextPageIds: z.array(z.string()).optional(),
  }),
}));
vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflow: mockUpsertCalendarTriggerWorkflow,
  upsertCalendarTriggerWorkflowInTx: mockUpsertCalendarTriggerWorkflowInTx,
  removeCalendarTrigger: mockRemoveCalendarTrigger,
  validateCalendarAgentTrigger: mockValidateCalendarAgentTrigger,
}));
vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  createTaskTriggerWorkflow: mockCreateTaskTriggerWorkflow,
  recomputeTaskTriggerMetadata: mockRecomputeTaskTriggerMetadata,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: mockIsUserDriveMember,
}));
vi.mock('../actor-permissions', () => ({
  canActorEditPage: mockCanActorEditPage,
  canActorManageDrive: mockCanActorManageDrive,
  driveDeniedByAppToken: mockDriveDeniedByAppToken,
}));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: mockBroadcastCalendarEvent }));
vi.mock('@/lib/websocket', () => ({ broadcastTaskEvent: mockBroadcastTaskEvent }));
vi.mock('../core/timestamp-utils', () => ({
  parseDateTime: vi.fn((s: string) => new Date(s)),
  normalizeTimezone: vi.fn((tz: string) => tz ?? 'UTC'),
}));

import { triggerTools } from '../trigger-tools';

type TR = { success: boolean; error?: string; [key: string]: unknown };

function ctx(overrides: Record<string, unknown> = {}) {
  return { toolCallId: '1', messages: [], experimental_context: { userId: 'user-1', timezone: 'UTC', ...overrides } };
}

const TRIGGER_AT = '2026-07-01T09:00:00Z';
const SAMPLE_EVENT = {
  id: 'ev-1', title: 'Stand-up', startAt: new Date(TRIGGER_AT), endAt: new Date('2026-07-01T10:00:00Z'),
  timezone: 'UTC', driveId: 'drive-1', createdById: 'user-1', isTrashed: false, recurrenceRule: null, recurrenceExceptions: [],
  allDay: false, visibility: 'DRIVE', color: 'default', metadata: null, pageId: null, description: null, location: null, updatedAt: new Date(),
};

const SAMPLE_TASK = {
  id: 'task-1', dueDate: new Date('2026-07-15T00:00:00Z'), metadata: null,
  page: { parentId: 'tasklist-page-1' },
};
const SAMPLE_TASKLIST_PAGE = { id: 'tasklist-page-1', driveId: 'drive-1', isTrashed: false };
const SAMPLE_TASKLIST = { id: 'tl-1' };

describe('triggerTools.set_calendar_trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDriveDeniedByAppToken.mockResolvedValue(false);
    mockBroadcastCalendarEvent.mockResolvedValue(undefined);
    mockBroadcastTaskEvent.mockResolvedValue(undefined);
    mockUpsertCalendarTriggerWorkflow.mockResolvedValue({ workflowId: 'wf-1', triggerId: 'ct-1' });
  });

  it('attaches trigger to existing event when calendarEventId is given', async () => {
    mockDbQuery.mockResolvedValue(SAMPLE_EVENT);
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'ev-1', agentPageId: 'agent-1', prompt: 'Run daily summary' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
    expect(result.calendarEventId).toBe('ev-1');
    expect(mockUpsertCalendarTriggerWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ calendarEventId: 'ev-1', agentTrigger: expect.objectContaining({ agentPageId: 'agent-1' }) }),
    );
  });

  it('rejects trigger on personal event (no driveId)', async () => {
    mockDbQuery.mockResolvedValue({ ...SAMPLE_EVENT, driveId: null });
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'ev-1', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/drive event/);
  });

  it('rejects when user is not creator or admin', async () => {
    mockDbQuery.mockResolvedValue({ ...SAMPLE_EVENT, createdById: 'other-user' });
    mockCanActorManageDrive.mockResolvedValue(false);
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'ev-1', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/creator or a drive admin/);
  });

  it('allows drive admin to attach trigger on another user\'s event', async () => {
    mockDbQuery.mockResolvedValue({ ...SAMPLE_EVENT, createdById: 'other-user' });
    mockCanActorManageDrive.mockResolvedValue(true);
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'ev-1', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
  });

  it('creates new event and trigger when triggerAt + driveId are provided', async () => {
    mockIsUserDriveMember.mockResolvedValue(true);
    mockValidateCalendarAgentTrigger.mockResolvedValue(undefined);
    mockDbTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'new-ev-1' }]) })) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
      };
      return fn(mockTx);
    });
    const result = await triggerTools.set_calendar_trigger.execute!(
      { triggerAt: TRIGGER_AT, driveId: 'drive-1', agentPageId: 'agent-1', prompt: 'Run at time' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
    expect(mockIsUserDriveMember).toHaveBeenCalledWith('user-1', 'drive-1');
    expect(mockValidateCalendarAgentTrigger).toHaveBeenCalled();
  });

  it('rejects when no calendarEventId and no triggerAt/driveId', async () => {
    const result = await triggerTools.set_calendar_trigger.execute!(
      { agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/calendarEventId.*triggerAt/);
  });

  it('rejects when neither prompt nor instructionPageId given', async () => {
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'ev-1', agentPageId: 'agent-1' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/prompt or instructionPageId/);
  });

  it('returns error when event not found', async () => {
    mockDbQuery.mockResolvedValue(undefined);
    const result = await triggerTools.set_calendar_trigger.execute!(
      { calendarEventId: 'missing-id', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects when unauthenticated', async () => {
    await expect(
      triggerTools.set_calendar_trigger.execute!(
        { calendarEventId: 'ev-1', agentPageId: 'agent-1', prompt: 'Run' },
        { toolCallId: '1', messages: [], experimental_context: {} },
      ),
    ).rejects.toThrow('User authentication required');
  });
});

describe('triggerTools.delete_calendar_trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDriveDeniedByAppToken.mockResolvedValue(false);
    mockBroadcastCalendarEvent.mockResolvedValue(undefined);
  });

  it('removes trigger and broadcasts', async () => {
    mockDbQuery.mockResolvedValue(SAMPLE_EVENT);
    const result = await triggerTools.delete_calendar_trigger.execute!(
      { calendarEventId: 'ev-1' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
    expect(mockRemoveCalendarTrigger).toHaveBeenCalledWith(expect.anything(), 'ev-1');
    expect(mockBroadcastCalendarEvent).toHaveBeenCalled();
  });

  it('rejects when user is not creator or admin', async () => {
    mockDbQuery.mockResolvedValue({ ...SAMPLE_EVENT, createdById: 'other-user' });
    mockCanActorManageDrive.mockResolvedValue(false);
    const result = await triggerTools.delete_calendar_trigger.execute!(
      { calendarEventId: 'ev-1' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
  });

  it('returns error when event not found', async () => {
    mockDbQuery.mockResolvedValue(undefined);
    const result = await triggerTools.delete_calendar_trigger.execute!(
      { calendarEventId: 'missing' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('triggerTools.set_task_trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBroadcastTaskEvent.mockResolvedValue(undefined);
    // Default multi-query mock: task → tasklist page → tasklist
    let callCount = 0;
    mockDbQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(SAMPLE_TASK);
      if (callCount === 2) return Promise.resolve(SAMPLE_TASKLIST_PAGE);
      return Promise.resolve(SAMPLE_TASKLIST);
    });
  });

  it('creates a due_date trigger on a task with due date', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'due_date', agentPageId: 'agent-1', prompt: 'Review task' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
    expect(mockCreateTaskTriggerWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', driveId: 'drive-1', agentTrigger: expect.objectContaining({ triggerType: 'due_date' }) }),
    );
    expect(mockBroadcastTaskEvent).toHaveBeenCalled();
  });

  it('creates a completion trigger', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'completion', agentPageId: 'agent-1', prompt: 'Post-completion work' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(true);
    expect(mockCreateTaskTriggerWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ agentTrigger: expect.objectContaining({ triggerType: 'completion' }) }),
    );
  });

  it('rejects due_date trigger when task has no due date', async () => {
    mockDbQuery.mockReset();
    let callCount = 0;
    mockDbQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ...SAMPLE_TASK, dueDate: null });
      if (callCount === 2) return Promise.resolve(SAMPLE_TASKLIST_PAGE);
      return Promise.resolve(SAMPLE_TASKLIST);
    });
    mockCanActorEditPage.mockResolvedValue(true);
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'due_date', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/due date/);
  });

  it('rejects when user lacks edit access', async () => {
    mockCanActorEditPage.mockResolvedValue(false);
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'due_date', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/edit access/);
  });

  it('rejects when task list has no driveId (personal task list)', async () => {
    mockDbQuery.mockReset();
    let callCount = 0;
    mockDbQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(SAMPLE_TASK);
      if (callCount === 2) return Promise.resolve({ ...SAMPLE_TASKLIST_PAGE, driveId: null });
      return Promise.resolve(SAMPLE_TASKLIST);
    });
    mockCanActorEditPage.mockResolvedValue(true);
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'completion', agentPageId: 'agent-1', prompt: 'Run' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/drive-based/);
  });

  it('rejects when neither prompt nor instructionPageId given', async () => {
    const result = await triggerTools.set_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'due_date', agentPageId: 'agent-1' },
      ctx(),
    ) as unknown as TR;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/prompt or instructionPageId/);
  });
});

describe('triggerTools.delete_task_trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBroadcastTaskEvent.mockResolvedValue(undefined);
    let callCount = 0;
    mockDbQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(SAMPLE_TASK);
      if (callCount === 2) return Promise.resolve(SAMPLE_TASKLIST_PAGE);
      return Promise.resolve(SAMPLE_TASKLIST);
    });
  });

  it('disables the trigger and recomputes metadata', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    const result = (await triggerTools.delete_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'due_date' },
      ctx(),
    )) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockRecomputeTaskTriggerMetadata).toHaveBeenCalledWith(expect.anything(), 'task-1', null);
    expect(mockBroadcastTaskEvent).toHaveBeenCalled();
  });

  it('rejects when user lacks edit access', async () => {
    mockCanActorEditPage.mockResolvedValue(false);
    const result = (await triggerTools.delete_task_trigger.execute!(
      { taskId: 'task-1', triggerType: 'completion' },
      ctx(),
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/edit access/);
  });
});
