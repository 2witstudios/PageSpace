import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockIncrementUsage,
  mockExecuteWorkflow,
  mockSelect,
  mockSelectFrom,
  mockSelectWhere,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
  mockIsUserDriveMember,
  mockInnerJoin,
  makeChildLogger,
} = vi.hoisted(() => {
  const makeChildLogger = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeChildLogger()),
  });
  return {
    mockIncrementUsage: vi.fn(),
    mockExecuteWorkflow: vi.fn(),
    mockSelect: vi.fn(),
    mockSelectFrom: vi.fn(),
    mockSelectWhere: vi.fn(),
    mockUpdate: vi.fn(),
    mockUpdateSet: vi.fn(),
    mockUpdateWhere: vi.fn(),
    mockIsUserDriveMember: vi.fn(),
    mockInnerJoin: vi.fn(),
    makeChildLogger,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {
    id: 'id',
    name: 'name',
    email: 'email',
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id',
    title: 'title',
    content: 'content',
    driveId: 'driveId',
    isTrashed: 'isTrashed',
  },
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  eventAttendees: {
    eventId: 'eventId',
    userId: 'userId',
  },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: {
    id: 'id',
    calendarEventId: 'calendarEventId',
    status: 'status',
  },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: {
    id: 'id',
  },
}));

vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

vi.mock('@/lib/subscription/usage-service', () => ({
  incrementUsage: mockIncrementUsage,
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    isUserDriveMember: mockIsUserDriveMember,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logger: { child: vi.fn(() => makeChildLogger()) },
  loggers: {
    api: { child: vi.fn(() => makeChildLogger()), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ai: { child: vi.fn(() => makeChildLogger()), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import type { CalendarEvent } from '@pagespace/db/schema/calendar'
import type { CalendarTrigger } from '@pagespace/db/schema/calendar-triggers';

// ============================================================================
// Fixtures
// ============================================================================

const createTrigger = (overrides: Partial<CalendarTrigger> = {}): CalendarTrigger => ({
  id: 'trg-1',
  workflowId: 'wf-1',
  calendarEventId: 'evt-1',
  driveId: 'drive-1',
  scheduledById: 'user-123',
  status: 'running',
  triggerAt: new Date('2026-01-15T10:00:00Z'),
  claimedAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
  error: null,
  durationMs: null,
  conversationId: null,
  occurrenceDate: new Date(0),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as CalendarTrigger);

const createWorkflowRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'wf-1',
  driveId: 'drive-1',
  createdBy: 'user-123',
  name: 'wf-1',
  agentPageId: 'agent-1',
  prompt: 'Check deploy status',
  contextPageIds: [],
  cronExpression: null,
  timezone: 'UTC',
  triggerType: 'cron',
  eventTriggers: null,
  watchedFolderIds: null,
  eventDebounceSecs: null,
  instructionPageId: null,
  isEnabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastRunStatus: 'never_run',
  lastRunError: null,
  lastRunDurationMs: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1',
  driveId: 'drive-1',
  createdById: 'user-123',
  title: 'Deploy check',
  description: 'Auto-check deploy',
  location: null,
  startAt: new Date('2026-01-15T10:00:00Z'),
  endAt: new Date('2026-01-15T10:15:00Z'),
  allDay: false,
  timezone: 'UTC',
  visibility: 'DRIVE',
  color: 'focus',
  recurrenceRule: null,
  metadata: null,
  isTrashed: false,
  trashedAt: null,
  pageId: null,
  syncSourceId: null,
  syncExternalId: null,
  syncExternalCalendarId: null,
  lastSyncedAt: null,
  updatedAt: new Date(),
  createdAt: new Date(),
  ...overrides,
} as CalendarEvent);

// ============================================================================
// Tests
// ============================================================================

describe('executeCalendarTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockIsUserDriveMember.mockResolvedValue(true);
    mockIncrementUsage.mockResolvedValue({ success: true });

    // Default select chain.
    // Call order in executor: 1=workflow load, 2=agent preflight, 3=attendees
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({
      innerJoin: mockInnerJoin,
      where: mockSelectWhere,
    });
    mockInnerJoin.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere
      .mockResolvedValueOnce([createWorkflowRow()])                    // workflow load
      .mockResolvedValueOnce([{ id: 'agent-1', isTrashed: false }])    // agent preflight
      .mockResolvedValue([]);                                           // attendees + anything else

    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      durationMs: 500,
      conversationId: 'conv-1',
    });
  });

  it('returns success when workflow executes successfully', async () => {
    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a WorkflowExecutionInput composed from the linked workflow row', async () => {
    const workflow = createWorkflowRow({ prompt: 'Do the thing', agentPageId: 'agent-9' });
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([workflow])
      .mockResolvedValueOnce([{ id: 'agent-9', isTrashed: false }])
      .mockResolvedValue([]);
    const trigger = createTrigger();
    const event = createEvent({ timezone: 'America/New_York' });

    await executeCalendarTrigger(trigger, event);

    expect(mockExecuteWorkflow).toHaveBeenCalledOnce();
    const input = mockExecuteWorkflow.mock.calls[0][0];
    expect(input.workflowId).toBe('wf-1');
    expect(input.driveId).toBe(workflow.driveId);
    expect(input.createdBy).toBe(trigger.scheduledById);
    expect(input.agentPageId).toBe('agent-9');
    expect(input.timezone).toBe('America/New_York');
    expect(input.eventContext?.promptOverride).toContain('Do the thing');
    expect(input.prompt).toBe('Do the thing');
  });

  it('includes event context in the prompt override', async () => {
    const event = createEvent({
      title: 'Weekly standup',
      description: 'Team sync',
      location: 'Room 42',
    });

    await executeCalendarTrigger(createTrigger(), event);

    const input = mockExecuteWorkflow.mock.calls[0][0];
    const promptOverride = input.eventContext?.promptOverride ?? '';
    expect(promptOverride).toContain('Weekly standup');
    expect(promptOverride).toContain('Team sync');
    expect(promptOverride).toContain('Room 42');
  });

  it('includes attendees in the prompt override when present', async () => {
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([createWorkflowRow()])
      .mockResolvedValueOnce([{ id: 'agent-1', isTrashed: false }])
      .mockResolvedValueOnce([
        { name: 'Alice', email: 'alice@test.com' },
        { name: null, email: 'bob@test.com' },
      ])
      .mockResolvedValue([]);

    await executeCalendarTrigger(createTrigger(), createEvent());

    const promptOverride = mockExecuteWorkflow.mock.calls[0][0].eventContext?.promptOverride ?? '';
    expect(promptOverride).toContain('Alice');
    expect(promptOverride).toContain('bob@test.com');
  });

  it('fails when daily AI call limit is reached', async () => {
    mockIncrementUsage.mockResolvedValue({ success: false });

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain('limit');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('updates trigger status to completed on success', async () => {
    await executeCalendarTrigger(createTrigger(), createEvent());

    expect(mockUpdate).toHaveBeenCalled();
    const setCalls = mockUpdateSet.mock.calls;
    const completionCall = setCalls.find(
      (call) => call[0]?.status === 'completed'
    );
    expect(completionCall).toBeDefined();
  });

  it('updates trigger status to failed on workflow failure', async () => {
    mockExecuteWorkflow.mockResolvedValue({
      success: false,
      durationMs: 100,
      error: 'Agent crashed',
    });

    await executeCalendarTrigger(createTrigger(), createEvent());

    const setCalls = mockUpdateSet.mock.calls;
    const failureCall = setCalls.find(
      (call) => call[0]?.status === 'failed'
    );
    expect(failureCall).toBeDefined();
  });

  it('marks trigger as failed when executeWorkflow throws', async () => {
    mockExecuteWorkflow.mockRejectedValue(new Error('Unexpected explosion'));

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unexpected explosion');
  });

  it('saves conversationId when workflow returns one', async () => {
    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      durationMs: 200,
      conversationId: 'conv-abc',
    });

    await executeCalendarTrigger(createTrigger(), createEvent());

    const setCalls = mockUpdateSet.mock.calls;
    const completionCall = setCalls.find(
      (call) => call[0]?.status === 'completed'
    );
    expect(completionCall?.[0]?.conversationId).toBe('conv-abc');
  });

  it('fails when scheduling user no longer has drive access', async () => {
    mockIsUserDriveMember.mockResolvedValue(false);

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain('drive');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('fails when the linked workflow row is missing', async () => {
    mockSelectWhere.mockReset();
    mockSelectWhere.mockResolvedValueOnce([]); // workflow load returns nothing

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain('workflow');
    expect(mockIncrementUsage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('fails without consuming usage when agent page is missing', async () => {
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([createWorkflowRow()])
      .mockResolvedValueOnce([]); // agent preflight returns empty

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain('agent');
    expect(mockIncrementUsage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});
