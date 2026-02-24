import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkflowEvent } from '../event-trigger';

// ============================================================================
// Tests for event-trigger.ts
// ============================================================================

const {
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn().mockResolvedValue([]),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  workflows: {
    isEnabled: 'isEnabled',
    triggerType: 'triggerType',
    driveId: 'driveId',
    id: 'id',
    lastRunStatus: 'lastRunStatus',
    lastRunAt: 'lastRunAt',
  },
  pages: { id: 'id', parentId: 'parentId' },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('../workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { emitWorkflowEvent } from '../event-trigger';
import { executeWorkflow } from '../workflow-executor';

// ============================================================================
// Fixtures
// ============================================================================

const createWorkflow = (overrides: Record<string, unknown> = {}) => ({
  id: 'wf_1',
  driveId: 'drive_abc',
  name: 'Test Workflow',
  triggerType: 'event' as const,
  isEnabled: true,
  agentPageId: 'page_1',
  prompt: 'Process this event',
  contextPageIds: [],
  cronExpression: null,
  timezone: 'UTC',
  eventTriggers: [{ operation: 'create', resourceType: 'page' }],
  watchedFolderIds: null,
  eventDebounceSecs: 5,
  lastRunStatus: 'never_run',
  lastRunAt: null,
  lastRunError: null,
  lastRunDurationMs: null,
  nextRunAt: null,
  createdBy: 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const createEvent = (overrides: Partial<WorkflowEvent> = {}): WorkflowEvent => ({
  operation: 'create',
  resourceType: 'page',
  resourceId: 'res_1',
  driveId: 'drive_abc',
  pageId: null,
  userId: 'user_456',
  ...overrides,
});

// ============================================================================
// Setup
// ============================================================================

describe('emitWorkflowEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();

    // Default DB chain: select().from().where()
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([]);

    // Default update chain: update().set().where()
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Done',
      toolCallCount: 0,
      durationMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Early exits
  // --------------------------------------------------------------------------

  test('no driveId', async () => {
    const event = createEvent({ driveId: null });

    await emitWorkflowEvent(event);

    expect(mockSelect).not.toHaveBeenCalled();
  });

  test('recursive trigger prevention', async () => {
    const event = createEvent({
      isAiGenerated: true,
      aiConversationId: 'workflow-wf_1-1234',
    });

    await emitWorkflowEvent(event);

    expect(mockSelect).not.toHaveBeenCalled();
  });

  test('no enabled event workflows in drive', async () => {
    mockSelectWhere.mockResolvedValue([]);

    await emitWorkflowEvent(createEvent());

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Event matching
  // --------------------------------------------------------------------------

  test('matching event triggers execution after debounce', async () => {
    const workflow = createWorkflow();
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent());

    // Before debounce fires
    expect(executeWorkflow).not.toHaveBeenCalled();

    // Fire the debounce timer
    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Verify the prompt has event context prepended
    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    expect(calledArg.prompt).toContain('<event-data>');
    expect(calledArg.prompt).toContain('Event: create on page');
    expect(calledArg.prompt).toContain('Process this event');
  });

  test('non-matching event skips execution', async () => {
    const workflow = createWorkflow({
      eventTriggers: [{ operation: 'delete', resourceType: 'page' }],
    });
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent({ operation: 'create', resourceType: 'page' }));

    await vi.advanceTimersByTimeAsync(10000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Debounce coalescing
  // --------------------------------------------------------------------------

  test('rapid events coalesce into single execution', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 10 });
    mockSelectWhere.mockResolvedValue([workflow]);

    // Fire 3 events rapidly
    await emitWorkflowEvent(createEvent({ resourceId: 'res_1' }));
    await emitWorkflowEvent(createEvent({ resourceId: 'res_2' }));
    await emitWorkflowEvent(createEvent({ resourceId: 'res_3' }));

    await vi.advanceTimersByTimeAsync(10000);

    // Only one execution despite 3 events
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Should use the LATEST event context
    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    expect(calledArg.prompt).toContain('res_3');
  });

  // --------------------------------------------------------------------------
  // Folder scoping
  // --------------------------------------------------------------------------

  test('watched folder matches via event pageId', async () => {
    const workflow = createWorkflow({
      watchedFolderIds: ['folder_a'],
    });
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent({ pageId: 'folder_a' }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  test('watched folder matches via resource parentId', async () => {
    const workflow = createWorkflow({
      watchedFolderIds: ['folder_b'],
    });

    // Call 1: find matching workflows
    // Call 2: resource parent lookup
    // Call 3: re-validation during debounce (returns the workflow as enabled)
    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      if (callCount === 2) return [{ parentId: 'folder_b' }];
      return [workflow]; // re-validation
    });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelect.mockReturnValue({ from: mockSelectFrom });

    await emitWorkflowEvent(createEvent({ pageId: 'unrelated_page' }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  test('event outside watched folders skips execution', async () => {
    const workflow = createWorkflow({
      watchedFolderIds: ['folder_a'],
    });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      // Resource is in a different folder
      return [{ parentId: 'folder_z' }];
    });

    await emitWorkflowEvent(createEvent({ pageId: 'other_page' }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Debounce re-validation
  // --------------------------------------------------------------------------

  test('workflow disabled during debounce is not executed', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 5 });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      // First call: find matching workflows
      if (callCount === 1) return [workflow];
      // Re-fetch during debounce: workflow is now disabled
      return [{ ...workflow, isEnabled: false }];
    });

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  test('workflow deleted during debounce is not executed', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 5 });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      // Re-fetch during debounce: workflow deleted
      return [];
    });

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  test('workflow edited during debounce executes with fresh prompt', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 5, prompt: 'Old prompt' });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      // Re-fetch during debounce: prompt was edited
      return [{ ...workflow, prompt: 'Updated prompt' }];
    });

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    expect(calledArg.prompt).toContain('Updated prompt');
    expect(calledArg.prompt).not.toContain('Old prompt');
  });

  test('workflow trigger type changed to cron during debounce is not executed', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 5 });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      // Re-fetch during debounce: trigger type was switched to cron
      return [{ ...workflow, triggerType: 'cron' }];
    });

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  test('workflow already running during debounce is not executed', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 5 });

    let callCount = 0;
    mockSelectWhere.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [workflow];
      // Re-fetch during debounce: workflow is currently running
      return [{ ...workflow, lastRunStatus: 'running' }];
    });

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(5000);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Workflow status updates
  // --------------------------------------------------------------------------

  test('marks workflow running then updates status on success', async () => {
    const workflow = createWorkflow();
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent());
    await vi.advanceTimersByTimeAsync(5000);

    // update() called for: mark running + update status
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  test('marks workflow as error when execution fails', async () => {
    const workflow = createWorkflow();
    mockSelectWhere.mockResolvedValue([workflow]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 50,
      error: 'Agent failed',
    });

    await emitWorkflowEvent(createEvent());
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastRunStatus: 'error', lastRunError: 'Agent failed' })
    );
  });
});

// ============================================================================
// buildEventContext (tested indirectly via prompt injection)
// ============================================================================

describe('buildEventContext', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();

    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Done',
      toolCallCount: 0,
      durationMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('includes metadata title and folder in context', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 1 });
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent({
      metadata: { resourceTitle: 'My Page', folderName: 'Reports' },
    }));

    await vi.advanceTimersByTimeAsync(1000);

    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    expect(calledArg.prompt).toContain('Name: My Page');
    expect(calledArg.prompt).toContain('Folder: Reports');
  });

  test('truncates excessively long metadata values', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 1 });
    mockSelectWhere.mockResolvedValue([workflow]);

    const longTitle = 'A'.repeat(300);
    await emitWorkflowEvent(createEvent({
      metadata: { resourceTitle: longTitle },
    }));

    await vi.advanceTimersByTimeAsync(1000);

    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    // Should be truncated to 200 chars + "..."
    expect(calledArg.prompt).not.toContain(longTitle);
    expect(calledArg.prompt).toContain('A'.repeat(200) + '...');
  });

  test('wraps context in structured delimiters', async () => {
    const workflow = createWorkflow({ eventDebounceSecs: 1 });
    mockSelectWhere.mockResolvedValue([workflow]);

    await emitWorkflowEvent(createEvent());

    await vi.advanceTimersByTimeAsync(1000);

    const calledArg = vi.mocked(executeWorkflow).mock.calls[0][0];
    expect(calledArg.prompt).toContain('<event-data>');
    expect(calledArg.prompt).toContain('</event-data>');
  });
});
