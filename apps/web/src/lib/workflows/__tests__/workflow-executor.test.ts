import { describe, test, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Tests for workflow-executor.ts
// ============================================================================

const {
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockResolvePageAgentIntegrationTools,
} = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockResolvePageAgentIntegrationTools: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: mockSelect, query: { taskItems: { findFirst: vi.fn() } } },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', name: 'name' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', isTrashed: 'isTrashed', title: 'title', content: 'content', parentId: 'parentId', driveId: 'driveId' },
  drives: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'id' },
  taskAssignees: { taskId: 'taskId', userId: 'userId', agentPageId: 'agentPageId' },
  taskStatusConfigs: { taskListId: 'taskListId', slug: 'slug' },
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
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
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

vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: mockResolvePageAgentIntegrationTools,
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { executeWorkflow, type WorkflowExecutionInput } from '../workflow-executor';
import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { saveMessageToDatabase } from '@/lib/ai/core/message-utils';

const createInputFixture = (overrides: Partial<WorkflowExecutionInput> = {}): WorkflowExecutionInput => ({
  workflowId: 'wf_1',
  workflowName: 'Test Workflow',
  driveId: 'drive_abc',
  createdBy: 'user_123',
  agentPageId: 'agent_1',
  prompt: 'Generate a report',
  contextPageIds: [],
  instructionPageId: null,
  timezone: 'UTC',
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

describe('executeWorkflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue(mockProviderResult as never);
    mockResolvePageAgentIntegrationTools.mockResolvedValue({});
    vi.mocked(generateText).mockResolvedValue({
      text: 'Report complete',
      steps: [{ text: 'Report complete', toolCalls: [{}] }],
      usage: { inputTokens: 100, outputTokens: 50 },
    } as never);
  });

  test('missing agent page returns error', async () => {
    setupSelectChain([]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page not found');
    expect(generateText).not.toHaveBeenCalled();
  });

  test('trashed agent page returns error', async () => {
    setupSelectChain([{ ...mockAgent, isTrashed: true }]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page is in trash');
  });

  test('non-AI_CHAT agent returns error', async () => {
    setupSelectChain([{ ...mockAgent, type: 'DOCUMENT' }]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent page is not an AI_CHAT type');
  });

  test('missing drive returns error', async () => {
    setupSelectChain([mockAgent], []);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Drive not found');
  });

  test('AI provider error returns error', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    vi.mocked(isProviderError).mockReturnValue(true);
    vi.mocked(createAIProvider).mockResolvedValue({ error: 'No API key' } as never);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI provider error');
  });

  test('successful execution with tools', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    expect(result.responseText).toBe('Report complete');
    expect(result.toolCallCount).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(generateText).toHaveBeenCalledTimes(1);

    const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(genCall.tools).toBeDefined();
    const toolKeys = Object.keys(genCall.tools as object);
    expect(toolKeys).toContain('list_pages');
    expect(toolKeys).toContain('create_page');
    expect(toolKeys).not.toContain('search_pages');
  });

  test('merges granted integration tools for workflow agents', async () => {
    setupSelectChain(
      [{ ...mockAgent, enabledTools: [] }],
      [mockDrive],
    );
    mockResolvePageAgentIntegrationTools.mockResolvedValue({
      github_create_issue: { name: 'github_create_issue' },
    });

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    expect(mockResolvePageAgentIntegrationTools).toHaveBeenCalledWith({
      agentId: 'agent_1',
      userId: 'user_123',
      driveId: 'drive_abc',
    });

    const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    const toolKeys = Object.keys(genCall.tools as object);
    expect(toolKeys).toContain('github_create_issue');
  });

  test('execution without tools when enabledTools is empty', async () => {
    setupSelectChain(
      [{ ...mockAgent, enabledTools: [] }],
      [mockDrive],
    );

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    expect(genCall.tools).toBeUndefined();
  });

  test('appends context page content to prompt', async () => {
    setupSelectChain(
      [mockAgent],
      [mockDrive],
      [{ id: 'ctx_1', title: 'Meeting Notes', content: 'Discussed Q4 goals' }],
    );

    const input = createInputFixture({ contextPageIds: ['ctx_1'] });
    const result = await executeWorkflow(input);

    expect(result.success).toBe(true);
    const saveCall = vi.mocked(saveMessageToDatabase).mock.calls[0][0];
    expect(saveCall.content).toContain('Meeting Notes');
    expect(saveCall.content).toContain('Discussed Q4 goals');
  });

  test('context page query includes driveId filter', async () => {
    const { eq, and, inArray } = await import('@pagespace/db/operators');
    setupSelectChain(
      [mockAgent],
      [mockDrive],
      [{ id: 'ctx_1', title: 'Same Drive Page', content: 'Safe content' }],
    );

    const input = createInputFixture({ contextPageIds: ['ctx_1'] });
    await executeWorkflow(input);

    expect(and).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith('driveId', 'drive_abc');
    expect(inArray).toHaveBeenCalledWith('id', ['ctx_1']);
  });

  test('eventContext.promptOverride replaces the workflow prompt for this run', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const input = createInputFixture({
      prompt: 'Stored workflow prompt',
      eventContext: { promptOverride: '<scheduled-event>...event prompt...</scheduled-event>' },
    });
    const result = await executeWorkflow(input);

    expect(result.success).toBe(true);
    const saveCall = vi.mocked(saveMessageToDatabase).mock.calls[0][0];
    expect(saveCall.content).toContain('event prompt');
    expect(saveCall.content).not.toContain('Stored workflow prompt');
  });

  test('saves user and assistant messages to database', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    await executeWorkflow(createInputFixture());

    expect(saveMessageToDatabase).toHaveBeenCalledTimes(2);
    const [userSave, assistantSave] = vi.mocked(saveMessageToDatabase).mock.calls;
    expect(userSave[0].role).toBe('user');
    expect(assistantSave[0].role).toBe('assistant');
    expect(assistantSave[0].content).toBe('Report complete');
  });

  test('thrown exception returns error with duration', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    vi.mocked(generateText).mockRejectedValue(new Error('Network timeout'));

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
