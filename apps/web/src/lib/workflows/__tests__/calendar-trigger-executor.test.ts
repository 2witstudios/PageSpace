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

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  calendarTriggers: {
    id: 'id',
    calendarEventId: 'calendarEventId',
    status: 'status',
  },
  pages: {
    id: 'id',
    title: 'title',
    content: 'content',
    driveId: 'driveId',
    isTrashed: 'isTrashed',
  },
  eventAttendees: {
    eventId: 'eventId',
    userId: 'userId',
  },
  users: {
    id: 'id',
    name: 'name',
    email: 'email',
  },
  eq: vi.fn(),
  and: vi.fn(),
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

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: mockIsUserDriveMember,
  logger: { child: vi.fn(() => makeChildLogger()) },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { child: vi.fn(() => makeChildLogger()), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ai: { child: vi.fn(() => makeChildLogger()), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import type { CalendarTrigger, CalendarEvent } from '@pagespace/db';

// ============================================================================
// Fixtures
// ============================================================================

const createTrigger = (overrides: Partial<CalendarTrigger> = {}): CalendarTrigger => ({
  id: 'trg-1',
  calendarEventId: 'evt-1',
  agentPageId: 'agent-1',
  driveId: 'drive-1',
  scheduledById: 'user-123',
  prompt: 'Check deploy status',
  instructionPageId: null,
  contextPageIds: [],
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

    // Default: scheduling user still has drive access
    mockIsUserDriveMember.mockResolvedValue(true);

    // Default: rate limit passes
    mockIncrementUsage.mockResolvedValue({ success: true });

    // Default select chain: agent page preflight → attendees → etc.
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({
      innerJoin: mockInnerJoin,
      where: mockSelectWhere,
    });
    mockInnerJoin.mockReturnValue({ where: mockSelectWhere });
    // First call: agent page preflight (exists, not trashed)
    // Subsequent calls: empty (no attendees, etc.)
    mockSelectWhere
      .mockResolvedValueOnce([{ id: 'agent-1', isTrashed: false }])
      .mockResolvedValue([]);

    // Default: update succeeds
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    // Default: workflow execution succeeds
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

  it('passes a synthetic workflow to executeWorkflow with correct fields', async () => {
    const trigger = createTrigger({ prompt: 'Do the thing' });
    const event = createEvent({ timezone: 'America/New_York' });

    await executeCalendarTrigger(trigger, event);

    expect(mockExecuteWorkflow).toHaveBeenCalledOnce();
    const syntheticWorkflow = mockExecuteWorkflow.mock.calls[0][0];
    expect(syntheticWorkflow.id).toBe(trigger.id);
    expect(syntheticWorkflow.driveId).toBe(trigger.driveId);
    expect(syntheticWorkflow.createdBy).toBe(trigger.scheduledById);
    expect(syntheticWorkflow.agentPageId).toBe(trigger.agentPageId);
    expect(syntheticWorkflow.timezone).toBe('America/New_York');
    expect(syntheticWorkflow.prompt).toContain('Do the thing');
  });

  it('includes event context in the prompt', async () => {
    const event = createEvent({
      title: 'Weekly standup',
      description: 'Team sync',
      location: 'Room 42',
    });

    await executeCalendarTrigger(createTrigger(), event);

    const syntheticWorkflow = mockExecuteWorkflow.mock.calls[0][0];
    expect(syntheticWorkflow.prompt).toContain('Weekly standup');
    expect(syntheticWorkflow.prompt).toContain('Team sync');
    expect(syntheticWorkflow.prompt).toContain('Room 42');
  });

  it('includes attendees in the prompt when present', async () => {
    // Reset beforeEach chain, set up: agent preflight → attendees
    mockSelectWhere.mockReset();
    mockSelectWhere
      .mockResolvedValueOnce([{ id: 'agent-1', isTrashed: false }])
      .mockResolvedValueOnce([
        { name: 'Alice', email: 'alice@test.com' },
        { name: null, email: 'bob@test.com' },
      ])
      .mockResolvedValue([]);

    await executeCalendarTrigger(createTrigger(), createEvent());

    const syntheticWorkflow = mockExecuteWorkflow.mock.calls[0][0];
    expect(syntheticWorkflow.prompt).toContain('Alice');
    expect(syntheticWorkflow.prompt).toContain('bob@test.com');
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

    // The update call that writes completed status
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

  it('re-checks instruction page access at execution time', async () => {
    const trigger = createTrigger({ instructionPageId: 'instr-page-1' });

    // Call order: 1=agent preflight, 2=attendees, 3=instruction page
    mockSelectWhere.mockReset();
    let callCount = 0;
    mockSelectWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: 'agent-1', isTrashed: false }]); // agent preflight
      if (callCount === 2) return Promise.resolve([]); // attendees
      // instruction page — belongs to a different drive
      return Promise.resolve([{
        title: 'Instructions',
        content: 'Do X then Y',
        driveId: 'other-drive',
      }]);
    });

    // First call: drive access check (pass), second call: instruction page drive (deny)
    mockIsUserDriveMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await executeCalendarTrigger(trigger, createEvent());

    // Workflow should still run — instruction page content is just omitted
    expect(mockExecuteWorkflow).toHaveBeenCalledOnce();
    const prompt = mockExecuteWorkflow.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('Do X then Y');
  });

  it('includes instruction page content when access is valid', async () => {
    const trigger = createTrigger({ instructionPageId: 'instr-page-1' });

    mockSelectWhere.mockReset();
    let callCount = 0;
    mockSelectWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ id: 'agent-1', isTrashed: false }]); // agent preflight
      if (callCount === 2) return Promise.resolve([]); // attendees
      return Promise.resolve([{
        title: 'Instructions',
        content: 'Do X then Y',
        driveId: 'drive-1', // same drive as trigger
      }]);
    });

    mockIsUserDriveMember.mockResolvedValue(true);

    await executeCalendarTrigger(trigger, createEvent());

    const prompt = mockExecuteWorkflow.mock.calls[0][0].prompt;
    expect(prompt).toContain('Do X then Y');
    expect(prompt).toContain('Instructions');
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

  it('fails without consuming usage when agent page is missing', async () => {
    // Override default: agent page preflight returns empty (deleted since scheduling)
    mockSelectWhere.mockReset();
    mockSelectWhere.mockResolvedValue([]);

    const result = await executeCalendarTrigger(createTrigger(), createEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain('agent');
    expect(mockIncrementUsage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});
