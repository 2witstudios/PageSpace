import { describe, test, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Tests for workflow-executor.ts
// ============================================================================

// Hoist mock functions
const {
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: { select: mockSelect },
  pages: { id: 'id', isTrashed: 'isTrashed', title: 'title', content: 'content', parentId: 'parentId', driveId: 'driveId' },
  drives: { id: 'id' },
  workflows: { $inferSelect: {} },
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  convertToModelMessages: vi.fn((msgs) => msgs),
  stepCountIs: vi.fn(() => () => false),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config) => config),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn(),
  isProviderError: vi.fn(),
  pageSpaceTools: {
    list_pages: { name: 'list_pages' },
    create_page: { name: 'create_page' },
    search_pages: { name: 'search_pages' },
  },
  buildTimestampSystemPrompt: vi.fn(() => 'Timestamp: now'),
}));

vi.mock('@/lib/ai/core/message-utils', () => ({
  saveMessageToDatabase: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { executeWorkflow } from '../workflow-executor';
import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { saveMessageToDatabase } from '@/lib/ai/core/message-utils';

// ============================================================================
// Fixtures
// ============================================================================

const createWorkflowFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'wf_1',
  driveId: 'drive_abc',
  createdBy: 'user_123',
  name: 'Test Workflow',
  agentPageId: 'agent_1',
  prompt: 'Generate a report',
  contextPageIds: [],
  cronExpression: '0 9 * * 1-5',
  timezone: 'UTC',
  triggerType: 'cron' as const,
  eventTriggers: null,
  watchedFolderIds: null,
  eventDebounceSecs: null,
  taskItemId: null,
  instructionPageId: null,
  isEnabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastRunStatus: 'never_run' as const,
  lastRunError: null,
  lastRunDurationMs: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const mockAgent = {
  id: 'agent_1',
  type: 'AI_CHAT',
  isTrashed: false,
  title: 'Report Agent',
  systemPrompt: 'You are a report generator.',
  includeDrivePrompt: false,
  aiProvider: 'pagespace',
  aiModel: 'glm-4.5-air',
  enabledTools: ['list_pages', 'create_page'],
  driveId: 'drive_abc',
};

const mockDrive = {
  id: 'drive_abc',
  name: 'Test Drive',
  slug: 'test-drive',
  drivePrompt: null,
};

const mockProviderResult = {
  model: { id: 'mock-model' },
  provider: 'pagespace',
  modelName: 'glm-4.5-air',
};

// ============================================================================
// Helpers
// ============================================================================

/** Set up the mock DB select chain to return specific values in sequence. */
function setupSelectChain(...results: unknown[][]) {
  let callIdx = 0;
  mockSelectWhere.mockImplementation(async () => {
    const result = results[callIdx] ?? [];
    callIdx++;
    return result;
  });
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
}

// ============================================================================
// Tests
// ============================================================================

describe('executeWorkflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue(mockProviderResult as never);
    vi.mocked(generateText).mockResolvedValue({
      text: 'Report complete',
      steps: [{ text: 'Report complete', toolCalls: [{}] }],
      usage: { inputTokens: 100, outputTokens: 50 },
    } as never);
  });

  // --------------------------------------------------------------------------
  // Agent validation
  // --------------------------------------------------------------------------

  test('missing agent page returns error', async () => {
    setupSelectChain([]); // No agent found

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page not found');
    expect(generateText).not.toHaveBeenCalled();
  });

  test('trashed agent page returns error', async () => {
    setupSelectChain([{ ...mockAgent, isTrashed: true }]);

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page is in trash');
    expect(generateText).not.toHaveBeenCalled();
  });

  test('non-AI_CHAT agent returns error', async () => {
    setupSelectChain([{ ...mockAgent, type: 'DOCUMENT' }]);

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page is not an AI_CHAT type');
  });

  // --------------------------------------------------------------------------
  // Drive validation
  // --------------------------------------------------------------------------

  test('missing drive returns error', async () => {
    setupSelectChain([mockAgent], []); // Agent found, no drive

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Drive not found');
  });

  // --------------------------------------------------------------------------
  // Provider errors
  // --------------------------------------------------------------------------

  test('AI provider error returns error', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    vi.mocked(isProviderError).mockReturnValue(true);
    vi.mocked(createAIProvider).mockResolvedValue({ error: 'No API key' } as never);

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI provider error');
    expect(generateText).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  test('successful execution with tools', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(true);
    expect(result.responseText).toBe('Report complete');
    expect(result.toolCallCount).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(generateText).toHaveBeenCalledTimes(1);

    // Verify tools were filtered to only enabled ones
    const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(genCall.tools).toBeDefined();
    const toolKeys = Object.keys(genCall.tools as object);
    expect(toolKeys).toContain('list_pages');
    expect(toolKeys).toContain('create_page');
    expect(toolKeys).not.toContain('search_pages');
  });

  test('execution without tools when enabledTools is empty', async () => {
    setupSelectChain(
      [{ ...mockAgent, enabledTools: [] }],
      [mockDrive],
    );

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(true);
    // No tools property when empty
    const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(genCall.tools).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Context pages
  // --------------------------------------------------------------------------

  test('appends context page content to prompt', async () => {
    setupSelectChain(
      [mockAgent],
      [mockDrive],
      [{ id: 'ctx_1', title: 'Meeting Notes', content: 'Discussed Q4 goals' }], // context pages
    );

    const workflow = createWorkflowFixture({ contextPageIds: ['ctx_1'] });
    const result = await executeWorkflow(workflow);

    expect(result.success).toBe(true);
    // The user message should contain context docs
    const saveCall = vi.mocked(saveMessageToDatabase).mock.calls[0][0];
    expect(saveCall.content).toContain('Meeting Notes');
    expect(saveCall.content).toContain('Discussed Q4 goals');
  });

  test('context page query includes driveId filter', async () => {
    const { eq, and, inArray } = await import('@pagespace/db');
    setupSelectChain(
      [mockAgent],
      [mockDrive],
      [{ id: 'ctx_1', title: 'Same Drive Page', content: 'Safe content' }],
    );

    const workflow = createWorkflowFixture({ contextPageIds: ['ctx_1'] });
    await executeWorkflow(workflow);

    // The third select call is for context pages — verify `and()` was called
    // with driveId filter (eq(pages.driveId, workflow.driveId))
    expect(and).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith('driveId', 'drive_abc');
    expect(inArray).toHaveBeenCalledWith('id', ['ctx_1']);
  });

  // --------------------------------------------------------------------------
  // Message saving
  // --------------------------------------------------------------------------

  test('saves user and assistant messages to database', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    await executeWorkflow(createWorkflowFixture());

    expect(saveMessageToDatabase).toHaveBeenCalledTimes(2);
    const [userSave, assistantSave] = vi.mocked(saveMessageToDatabase).mock.calls;
    expect(userSave[0].role).toBe('user');
    expect(assistantSave[0].role).toBe('assistant');
    expect(assistantSave[0].content).toBe('Report complete');
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  test('thrown exception returns error with duration', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    vi.mocked(generateText).mockRejectedValue(new Error('Network timeout'));

    const result = await executeWorkflow(createWorkflowFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
