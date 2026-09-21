import { describe, test, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Tests for workflow-executor.ts
// ============================================================================

const {
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockResolvePageAgentIntegrationTools,
  mockInsert,
  mockInsertValues,
  mockOnConflictDoNothing,
  mockInsertReturning,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
  mockToolExecute,
  mockResolveSandboxToolEligibility,
} = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockResolvePageAgentIntegrationTools: vi.fn(),
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoNothing: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockToolExecute: vi.fn(),
  mockResolveSandboxToolEligibility: vi.fn(),
}));

// The credit gate executeWorkflow runs on EVERY entry point (Phase 1b / D-33).
// Plain recorders, not vi.fn(), so resetAllMocks in each suite cannot wipe the
// default "allowed" decision the pre-existing tests rely on.
const creditGate = vi.hoisted(() => ({
  decision: { allowed: true, holdId: 'hold_1' } as
    | { allowed: true; holdId?: string }
    | { allowed: false; reason: 'too_many_in_flight' | 'daily_cap_exceeded' | 'out_of_credits' | 'requires_funding' | 'needs_init' },
  calls: [] as unknown[],
  released: [] as string[],
  throws: null as Error | null,
}));
vi.mock('../workflow-credit-gate', () => ({
  acquireWorkflowCredit: async (input: unknown) => {
    creditGate.calls.push(input);
    if (creditGate.throws) throw creditGate.throws;
    return creditGate.decision;
  },
}));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  // Records only after a macrotask, so a `released` assertion made when
  // executeWorkflow resolves proves the release was AWAITED, not fired off.
  releaseHold: async (holdId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    creditGate.released.push(holdId);
  },
}));

vi.mock('@/lib/ai/core/sandbox-tool-eligibility', () => ({
  resolveSandboxToolEligibility: (...args: unknown[]) => mockResolveSandboxToolEligibility(...args),
}));

// The run-scoped session mint for sandbox-capable runs (review #2326) — the
// executor spawns a real session + bound conversation before generateText and
// ends it in finally. Stubbed here: this suite covers filtering/context
// wiring, not session lifecycle (spawn refusal degrades to no sandbox tools,
// which the default ok:false below exercises without a DB).
const { mockSpawnSession, mockCreateConversationInSession, mockEndSession } = vi.hoisted(() => ({
  // Untyped vi.fn(): implementations live in beforeEach (resetAllMocks wipes
  // them), and the loose type lets tests resolve either spawn-result variant.
  mockSpawnSession: vi.fn(),
  mockCreateConversationInSession: vi.fn(),
  mockEndSession: vi.fn(),
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  spawnSession: mockSpawnSession,
  createConversationInSession: mockCreateConversationInSession,
  endSession: mockEndSession,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    query: { taskItems: { findFirst: vi.fn() }, taskLists: { findFirst: vi.fn() } },
  },
}));
// The one-row-per-occurrence guard is proven against real Postgres in
// record-unstarted-run.integration.test.ts; here it forwards to the insert mock
// so these tests can read the error row the executor asked for.
vi.mock('../record-unstarted-run', () => ({
  recordUnstartedRunOnce: async (row: Record<string, unknown>) => {
    const [inserted] = await mockInsert().values({ ...row, status: 'error', endedAt: new Date() }).returning();
    return inserted?.id;
  },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: { id: 'id', workflowId: 'workflowId', status: 'status' },
}));
vi.mock('@pagespace/db/schema/workflow-run-steps', () => ({
  workflowRunSteps: { id: 'id', runId: 'runId', position: 'position', status: 'status' },
}));
vi.mock('@/lib/ai/core/deterministic-tools', async () => {
  const { z } = await import('zod');
  return {
    DETERMINISTIC_TOOL_ALLOWLIST: ['insert_content', 'send_channel_message'] as const,
    getDeterministicTools: () => ({
      insert_content: {
        inputSchema: z.object({
          pageId: z.string(),
          anchor: z.string(),
          content: z.string(),
          position: z.enum(['before', 'after']),
        }),
        execute: mockToolExecute,
      },
    }),
  };
});
vi.mock('@pagespace/db/operators', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  users: { id: 'id', name: 'name' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', isTrashed: 'isTrashed', title: 'title', content: 'content', parentId: 'parentId', driveId: 'driveId' },
  drives: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'id' },
  taskLists: { id: 'id', pageId: 'pageId' },
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

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(),
  isProviderError: vi.fn(),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    list_pages: { name: 'list_pages' },
    create_page: { name: 'create_page' },
    search_pages: { name: 'search_pages' },
    bash: { name: 'bash' },
    spawn_session: { name: 'spawn_session' },
  },
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn(() => 'Timestamp: now'),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.4-nano',
}));

vi.mock('@/lib/repositories/message-repository', () => ({
  messageRepository: {
    savePageMessage: vi.fn().mockResolvedValue({ saved: true, rev: 1 }),
  },
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
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { messageRepository } from '@/lib/repositories/message-repository';

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
  source: { table: 'cron', id: null, triggerAt: null },
  ...overrides,
});

const mockAgent = {
  id: 'agent_1',
  type: 'AI_CHAT',
  isTrashed: false,
  title: 'Report Agent',
  systemPrompt: 'You are a report generator.',
  includeDrivePrompt: false,
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.4-nano',
  enabledTools: ['list_pages', 'create_page'],
  driveId: 'drive_abc',
};

const mockDrive = {
  id: 'drive_abc',
  name: 'Test Drive',
  slug: 'test-drive',
  drivePrompt: null,
  publishSubdomain: null,
};

const mockProviderResult = {
  model: { id: 'mock-model' },
  provider: 'openai',
  modelName: 'openai/gpt-5.4-nano',
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
    // resetAllMocks wipes implementations — restore the session-mint defaults
    // (spawn refused ⇒ the executor degrades to running without sandbox tools).
    mockSpawnSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true });
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue(mockProviderResult as never);
    mockResolvePageAgentIntegrationTools.mockResolvedValue({});
    mockResolveSandboxToolEligibility.mockResolvedValue(true);
    vi.mocked(generateText).mockResolvedValue({
      text: 'Report complete',
      steps: [{ text: 'Report complete', toolCalls: [{}] }],
      usage: { inputTokens: 100, outputTokens: 50 },
    } as never);

    // Default workflow_runs claim: succeeds with a fake run id.
    // Tests that exercise claim-conflict reset mockInsertReturning explicitly.
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
    mockOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([{ id: 'run_1' }]);

    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
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

  test('usage tracking is awaited — the usage write is durable before executeWorkflow resolves', async () => {
    // trackAIUsage's contract is explicit: it must be awaited so the usage log
    // (and the billing settle it drives) is durable before the caller returns.
    // A fire-and-forget call here would let a hold be released (and, in the
    // billing-off ceiling path, a next run be admitted) before the cost lands.
    // Barrier-style proof: hold the tracking promise open, assert the workflow
    // CANNOT complete while it is pending, then release and assert completion —
    // a zero-delay timer could race and pass even against fire-and-forget.
    setupSelectChain([mockAgent], [mockDrive]);
    let resolveTracking!: () => void;
    let trackingCalled = false;
    const { AIMonitoring } = await import('@pagespace/lib/monitoring/ai-monitoring');
    vi.mocked(AIMonitoring.trackUsage).mockImplementation(() => {
      trackingCalled = true;
      return new Promise<void>((res) => {
        resolveTracking = res;
      }) as never;
    });

    const pending = executeWorkflow(createInputFixture());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(trackingCalled).toBe(true));
    // Flush several macrotask turns: with a fire-and-forget call the workflow
    // would complete here despite tracking still being pending.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    resolveTracking();
    const result = await pending;
    expect(result.success).toBe(true);
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

  describe('sandbox tool gating (agent.sandboxEnabled + payer tier)', () => {
    test('an agent with sandboxEnabled off never gets sandbox tools, even if enabledTools lists them', async () => {
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: false, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).not.toContain('bash');
      // Short-circuited before ever resolving payer tier — sandboxEnabled off
      // is decisive on its own.
      expect(mockResolveSandboxToolEligibility).not.toHaveBeenCalled();
    });

    test('an agent with sandboxEnabled on but an ineligible (free-tier) payer does not get sandbox tools', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(false);
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      expect(mockResolveSandboxToolEligibility).toHaveBeenCalledWith('drive_abc', 'user_123');
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).not.toContain('bash');
    });

    test('a MANUAL run strips the dispatch pair too — a fire-and-forget worker would outlive the run-scoped session the finally ends (codex round 11)', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(false);
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash', 'spawn_session'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(
        createInputFixture({ source: { table: 'manual', id: null, triggerAt: null } }),
      );

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).not.toContain('bash');
      expect(toolKeys).not.toContain('spawn_session');
      // Nothing survived that could act in a fresh run-scoped workspace.
      expect(mockSpawnSession).not.toHaveBeenCalled();
      expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    });

    test('a NON-interactive fire (cron/webhook/task/calendar) strips the dispatch pair and mints no session for the leftovers (codex round 7)', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(false);
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'spawn_session'] }],
        [mockDrive],
      );

      // Fixture default source is cron — no live user request, so
      // spawn_session's chat-pipeline dispatch could never authenticate.
      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).not.toContain('spawn_session');
      // Nothing left that could act in a fresh run-scoped workspace — no
      // session row is spent on it.
      expect(mockSpawnSession).not.toHaveBeenCalled();
      expect(mockCreateConversationInSession).not.toHaveBeenCalled();
    });

    test('a NON-interactive compute-eligible run still gets its run-scoped session — bash needs no dispatch', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-cron' } });
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash', 'spawn_session'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('bash');
      expect(toolKeys).not.toContain('spawn_session');
      expect(mockSpawnSession).toHaveBeenCalledTimes(1);
      expect(mockEndSession).toHaveBeenCalledWith('wf-ses-cron');
    });

    test('an agent with sandboxEnabled on and an eligible (Pro+) payer gets sandbox tools, backed by a run-scoped session', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-1' } });
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).toContain('bash');
      // The sandbox runner refuses session-less page conversations, so a
      // sandbox-capable run must execute against a REAL bound conversation —
      // and release the session's compute when the run ends (review #2326).
      expect(mockSpawnSession).toHaveBeenCalledTimes(1);
      expect(mockCreateConversationInSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'wf-ses-1', agentPageId: mockAgent.id }),
      );
      expect(mockEndSession).toHaveBeenCalledWith('wf-ses-1');
    });

    test('a spawn refusal (owner at session cap) degrades to running WITHOUT sandbox tools instead of failing the run', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: false, reason: 'session_limit_reached' });
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const toolKeys = Object.keys(genCall.tools as object);
      expect(toolKeys).toContain('list_pages');
      expect(toolKeys).not.toContain('bash');
      expect(mockCreateConversationInSession).not.toHaveBeenCalled();
      expect(mockEndSession).not.toHaveBeenCalled();
    });

    test('a RESOLVED teardown failure ({ok:false}) is retried and error-logged like a throw — not mistaken for success (codex round 10)', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-resolvedfail' } });
      mockEndSession.mockResolvedValue({ ok: false, reason: 'teardown_failed', detail: 'sprite kill timed out' });
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      // Both bounded attempts consumed — an {ok:false} resolution is a real
      // failure (the Sprite stays live and billing), never a success.
      expect(mockEndSession).toHaveBeenCalledTimes(2);
    });

    test('the tool context carries the workflow agent identity via chatSource — channel messages and session reads attribute to the agent (codex round 10)', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(false);
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(
        createInputFixture({ source: { table: 'manual', id: null, triggerAt: null } }),
      );

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      const ctx = genCall.experimental_context as { chatSource?: { type: string; agentPageId?: string } };
      expect(ctx.chatSource).toEqual({ type: 'page', agentPageId: 'agent_1', agentTitle: 'Report Agent' });
    });

    test('a transient endSession fault is retried once; the run still succeeds (durable backstop is the orphan reconcile cron)', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-retry' } });
      mockEndSession
        .mockRejectedValueOnce(new Error('transient teardown blip'))
        .mockResolvedValueOnce({ ok: true });
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      expect(mockEndSession).toHaveBeenCalledTimes(2);
      expect(mockEndSession).toHaveBeenNthCalledWith(2, 'wf-ses-retry');
    });

    test('a teardown that fails BOTH attempts still returns the workflow result — the reaper owns the residual', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-stuck' } });
      mockEndSession.mockRejectedValue(new Error('teardown keeps failing'));
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      expect(mockEndSession).toHaveBeenCalledTimes(2);
    });

    test('a conversation-bind failure ends the just-minted session and degrades to no sandbox tools', async () => {
      mockResolveSandboxToolEligibility.mockResolvedValue(true);
      mockSpawnSession.mockResolvedValue({ ok: true, session: { id: 'wf-ses-2' } });
      mockCreateConversationInSession.mockRejectedValue(new Error('bind blew up'));
      setupSelectChain(
        [{ ...mockAgent, sandboxEnabled: true, enabledTools: ['list_pages', 'bash'] }],
        [mockDrive],
      );

      const result = await executeWorkflow(createInputFixture());

      expect(result.success).toBe(true);
      const genCall = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(genCall.tools as object)).not.toContain('bash');
      // The scratch session must not be left live and billing.
      expect(mockEndSession).toHaveBeenCalledWith('wf-ses-2');
    });
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
      currentTools: {},
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
    const saveCall = vi.mocked(messageRepository.savePageMessage).mock.calls[0][0];
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
    const saveCall = vi.mocked(messageRepository.savePageMessage).mock.calls[0][0];
    expect(saveCall.content).toContain('event prompt');
    expect(saveCall.content).not.toContain('Stored workflow prompt');
  });

  test('saves user and assistant messages to database', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    await executeWorkflow(createInputFixture());

    expect(messageRepository.savePageMessage).toHaveBeenCalledTimes(2);
    const [userSave, assistantSave] = vi.mocked(messageRepository.savePageMessage).mock.calls;
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

  // ==========================================================================
  // workflow_runs lifecycle (TDD: Riteway-style assertions on the new claim
  // and finalize behavior — every fire writes one row at start, one update
  // at end, and a partial unique index loses its claim with claimConflict.)
  // ==========================================================================

  test('inserts a workflow_runs row at execute-start with the source coordinates', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const triggerAt = new Date('2026-04-15T09:00:00Z');
    await executeWorkflow(createInputFixture({
      source: { table: 'calendarTriggers', id: 'trg-42', triggerAt },
    }));

    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf_1',
      sourceTable: 'calendarTriggers',
      sourceId: 'trg-42',
      triggerAt,
      status: 'running',
    }));
    expect(mockOnConflictDoNothing).toHaveBeenCalled();
  });

  test('updates the workflow_runs row with success status, endedAt, and conversationId on finish', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    expect(result.runId).toBe('run_1');
    // The finalize update writes status, endedAt, durationMs, error, conversationId
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      endedAt: expect.any(Date),
      durationMs: expect.any(Number),
      error: null,
    }));
  });

  test('finalizes workflow_runs with status=error when execution fails', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    vi.mocked(generateText).mockRejectedValue(new Error('Agent crashed'));

    await executeWorkflow(createInputFixture());

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: 'Agent crashed',
    }));
  });

  test('returns claimConflict and skips execution when the partial unique index rejects the insert', async () => {
    // ON CONFLICT DO NOTHING returning [] means the (workflowId) WHERE
    // status='running' partial unique index already has a row for this workflow.
    mockInsertReturning.mockResolvedValueOnce([]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.claimConflict).toBe(true);
    expect(result.success).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
    // No finalize update happens because no run was claimed.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('surfaces a finalizeError on the result when the end-of-run UPDATE fails', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    // Simulate a transient DB failure on the finalize UPDATE.
    mockUpdateWhere.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await executeWorkflow(createInputFixture());

    // Execution itself completed successfully — the run text is there —
    // but persisted state diverges (row stuck in 'running'), so callers
    // see finalizeError.
    expect(result.success).toBe(true);
    expect(result.finalizeError).toBe('connection terminated');
  });
});

describe('executeWorkflow — explicit step chains', () => {
  /**
   * The insert mock must serve three shapes in step-chain runs:
   *   claim:        .values(...).onConflictDoNothing().returning()
   *   step row:     .values(...).returning()
   *   skipped batch: await .values(...)
   */
  function setupStepInserts() {
    let stepRowId = 0;
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockImplementation(() => ({
      onConflictDoNothing: mockOnConflictDoNothing,
      returning: vi.fn().mockResolvedValue([{ id: `step_${++stepRowId}` }]),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    }));
    mockOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([{ id: 'run_1' }]);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks wipes implementations — restore the session-mint defaults
    // (spawn refused ⇒ the executor degrades to running without sandbox tools).
    mockSpawnSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true });
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue(mockProviderResult as never);
    mockResolvePageAgentIntegrationTools.mockResolvedValue({});
    mockResolveSandboxToolEligibility.mockResolvedValue(true);
    vi.mocked(generateText).mockResolvedValue({
      text: 'AI step done',
      steps: [{ text: 'AI step done', toolCalls: [] }],
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);
    setupStepInserts();
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockToolExecute.mockResolvedValue({ success: true });
  });

  const toolStep = {
    kind: 'tool' as const,
    toolName: 'insert_content',
    args: { pageId: 'page_1', anchor: '## Log', content: 'hello', position: 'after' as const },
  };

  test('deterministic-only chain: tool runs, no AI provider, no generateText, no chat messages', async () => {
    const result = await executeWorkflow(
      createInputFixture({ agentPageId: null, prompt: '', steps: [toolStep] })
    );

    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(result.conversationId).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(createAIProvider).not.toHaveBeenCalled();
    expect(messageRepository.savePageMessage).not.toHaveBeenCalled();

    expect(mockToolExecute).toHaveBeenCalledTimes(1);
    const [args, options] = mockToolExecute.mock.calls[0];
    expect(args).toEqual(toolStep.args);
    expect(
      (options as { experimental_context: { userId: string } }).experimental_context.userId
    ).toBe('user_123');
  });

  test('$payload refs resolve from eventContext.payload before execution', async () => {
    const step = {
      ...toolStep,
      args: { ...toolStep.args, content: { $payload: 'issue.title' } },
    };
    const result = await executeWorkflow(
      createInputFixture({
        agentPageId: null,
        prompt: '',
        steps: [step],
        eventContext: { payload: { issue: { title: 'from-payload' } } },
      })
    );

    expect(result.success).toBe(true);
    expect(mockToolExecute.mock.calls[0][0]).toEqual({ ...toolStep.args, content: 'from-payload' });
  });

  test('$payload refs strict-fail without a payload (cron/manual) and the tool never runs', async () => {
    const step = { ...toolStep, args: { ...toolStep.args, content: { $payload: 'issue.title' } } };
    const result = await executeWorkflow(
      createInputFixture({ agentPageId: null, prompt: '', steps: [step] })
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no trigger payload/i);
    expect(mockToolExecute).not.toHaveBeenCalled();
  });

  test('fail-fast: failing step 1 skips step 2 and fails the run', async () => {
    mockToolExecute.mockResolvedValueOnce({ success: false, error: 'no edit permission' });

    const result = await executeWorkflow(
      createInputFixture({ agentPageId: null, prompt: '', steps: [toolStep, toolStep] })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('step 1');
    expect(result.error).toContain('no edit permission');
    expect(mockToolExecute).toHaveBeenCalledTimes(1);

    // The skipped batch insert recorded step 2 as skipped.
    const skippedBatches = mockInsertValues.mock.calls
      .map(([v]) => v)
      .filter((v): v is Array<Record<string, unknown>> => Array.isArray(v));
    expect(skippedBatches).toHaveLength(1);
    expect(skippedBatches[0]).toEqual([
      expect.objectContaining({ position: 1, status: 'skipped', toolName: 'insert_content' }),
    ]);
  });

  test('mixed chain: tool step then ai step — one generateText, aggregated counts', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(
      createInputFixture({
        agentPageId: null,
        prompt: '',
        steps: [toolStep, { kind: 'ai' as const, prompt: 'summarize', agentPageId: 'agent_1' }],
      })
    );

    expect(result.success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(mockToolExecute).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('ai step without any agent fails cleanly', async () => {
    const result = await executeWorkflow(
      createInputFixture({
        agentPageId: null,
        prompt: '',
        steps: [{ kind: 'ai' as const, prompt: 'p' }],
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no agentPageId');
    expect(generateText).not.toHaveBeenCalled();
  });

  test('tools outside the allowlist are rejected at run time', async () => {
    const result = await executeWorkflow(
      createInputFixture({
        agentPageId: null,
        prompt: '',
        steps: [{ kind: 'tool' as const, toolName: 'trash_drive', args: {} }],
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not deterministically invocable');
    expect(mockToolExecute).not.toHaveBeenCalled();
  });

  test('legacy runs (steps null) never write step rows', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    // Only the claim insert — values called exactly once.
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  test('no steps and no agentPageId fails without claiming AI resources', async () => {
    const result = await executeWorkflow(
      createInputFixture({ agentPageId: null, prompt: '', steps: null })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no steps and no agentPageId');
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('executeWorkflow — credit gate inside the executor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    creditGate.decision = { allowed: true, holdId: 'hold_1' };
    creditGate.calls = [];
    creditGate.released = [];
    creditGate.throws = null;
    mockSpawnSession.mockResolvedValue({ ok: false, reason: 'spawn_failed' });
    mockCreateConversationInSession.mockResolvedValue(undefined);
    mockEndSession.mockResolvedValue({ ok: true });
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue(mockProviderResult as never);
    mockResolvePageAgentIntegrationTools.mockResolvedValue({});
    mockResolveSandboxToolEligibility.mockResolvedValue(true);
    vi.mocked(generateText).mockResolvedValue({
      text: 'Report complete',
      steps: [{ text: 'Report complete', toolCalls: [] }],
      usage: { inputTokens: 1, outputTokens: 1 },
    } as never);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
    mockOnConflictDoNothing.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([{ id: 'run_1' }]);
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  test('given a terminal refusal (an unclaimed agent), should record ONE error run with the reason and never resolve a model', async () => {
    creditGate.decision = { allowed: false, reason: 'requires_funding' };
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning, onConflictDoNothing: mockOnConflictDoNothing });
    mockInsertReturning.mockResolvedValue([{ id: 'run_refused' }]);

    const result = await executeWorkflow(createInputFixture({ source: { table: 'cron', id: null, triggerAt: new Date() } }));

    expect(result).toMatchObject({
      success: false,
      error: 'AI credit gate denied: requires_funding',
      runId: 'run_refused',
      refusal: { reason: 'requires_funding', kind: 'terminal' },
    });
    expect(result.retryable).toBeFalsy();
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'AI credit gate denied: requires_funding' }),
    );
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled(); // not a running claim
    expect(createAIProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test('given a transient refusal for a fresh occurrence, should write NO run row so the next tick retries it', async () => {
    creditGate.decision = { allowed: false, reason: 'too_many_in_flight' };

    const result = await executeWorkflow(
      createInputFixture({ source: { table: 'calendarTriggers', id: 'ct_1', triggerAt: new Date(Date.now() - 60_000) } }),
    );

    expect(result).toMatchObject({
      success: false,
      error: 'AI credit gate denied: too_many_in_flight',
      retryable: true,
      refusal: { reason: 'too_many_in_flight', kind: 'transient' },
    });
    expect(result.runId).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test('given a transient refusal for an occurrence older than 24h, should stop retrying and record the error run', async () => {
    creditGate.decision = { allowed: false, reason: 'too_many_in_flight' };
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning, onConflictDoNothing: mockOnConflictDoNothing });
    mockInsertReturning.mockResolvedValue([{ id: 'run_expired' }]);

    const result = await executeWorkflow(
      createInputFixture({ source: { table: 'taskTriggers', id: 'tt_1', triggerAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }),
    );

    expect(result).toMatchObject({ runId: 'run_expired', refusal: { kind: 'transient' } });
    expect(result.retryable).toBeFalsy();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'AI credit gate denied: too_many_in_flight' }),
    );
  });

  test('given the daily cap is hit on a FRESH scheduled occurrence, should record it once and settle (terminal: it clears only when the UTC day rolls)', async () => {
    creditGate.decision = { allowed: false, reason: 'daily_cap_exceeded' };
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning, onConflictDoNothing: mockOnConflictDoNothing });
    mockInsertReturning.mockResolvedValue([{ id: 'run_capped' }]);

    const result = await executeWorkflow(
      createInputFixture({ source: { table: 'taskTriggers', id: 'tt_1', triggerAt: new Date(Date.now() - 60_000) } }),
    );

    expect(result).toMatchObject({
      runId: 'run_capped',
      refusal: { reason: 'daily_cap_exceeded', kind: 'terminal' },
    });
    expect(result.retryable).toBeFalsy();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'AI credit gate denied: daily_cap_exceeded' }),
    );
  });

  test.each([
    ['calendarTriggers', 'ct_1'],
    ['taskTriggers', 'tt_1'],
  ] as const)('given the gate itself throws for a fresh %s occurrence, should report it RETRYABLE with no run row so the caller keeps the source eligible', async (table, id) => {
    creditGate.throws = new Error('db down');

    const result = await executeWorkflow(
      createInputFixture({ source: { table, id, triggerAt: new Date(Date.now() - 60_000) } }),
    );

    expect(result).toMatchObject({ success: false, error: 'db down', retryable: true });
    expect(result.refusal).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test('given the gate itself throws for a fresh cron slot, should report it RETRYABLE with no run row', async () => {
    creditGate.throws = new Error('db down');

    const result = await executeWorkflow(createInputFixture({ source: { table: 'cron', id: null, triggerAt: new Date(Date.now() - 60_000) } }));

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('given the gate keeps throwing past the 24h window, should record ONE error run so the occurrence stops being re-discovered', async () => {
    creditGate.throws = new Error('db down');
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning, onConflictDoNothing: mockOnConflictDoNothing });
    mockInsertReturning.mockResolvedValue([{ id: 'run_gate_error' }]);

    const result = await executeWorkflow(
      createInputFixture({ source: { table: 'calendarTriggers', id: 'ct_1', triggerAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }),
    );

    expect(result).toMatchObject({ success: false, error: 'db down', runId: 'run_gate_error' });
    expect(result.retryable).toBeFalsy();
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: 'db down' }));
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
  });

  test('given a transient refusal on a webhook fire (nothing re-fires it), should record the error run instead of dropping the event', async () => {
    creditGate.decision = { allowed: false, reason: 'too_many_in_flight' };
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning, onConflictDoNothing: mockOnConflictDoNothing });
    mockInsertReturning.mockResolvedValue([{ id: 'run_webhook_refused' }]);

    const result = await executeWorkflow(
      createInputFixture({ source: { table: 'webhookTriggers', id: 'wt_1', triggerAt: new Date() } }),
    );

    expect(result).toMatchObject({
      runId: 'run_webhook_refused',
      refusal: { reason: 'too_many_in_flight', kind: 'transient' },
    });
    expect(result.retryable).toBeFalsy();
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  test('given a manual run, should gate the input it was handed (billed to createdBy)', async () => {
    setupSelectChain([mockAgent], [mockDrive]);
    const input = createInputFixture({ source: { table: 'manual', id: null, triggerAt: null } });

    await executeWorkflow(input);

    expect(creditGate.calls).toEqual([input]);
  });

  test('given an allowed gate, should run and release the hold once the run ends', async () => {
    setupSelectChain([mockAgent], [mockDrive]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(creditGate.released).toEqual(['hold_1']);
  });

  test('given a run that throws, should still release the hold', async () => {
    mockSelect.mockImplementation(() => {
      throw new Error('db down');
    });

    const result = await executeWorkflow(createInputFixture({ steps: [{ kind: 'ai', prompt: 'p' }] }));

    expect(result.success).toBe(false);
    expect(creditGate.released).toEqual(['hold_1']);
  });

  test('given the gate passes but the run claim conflicts, should release the hold it took', async () => {
    mockInsertReturning.mockResolvedValue([]);

    const result = await executeWorkflow(createInputFixture());

    expect(result.claimConflict).toBe(true);
    expect(creditGate.released).toEqual(['hold_1']);
    expect(generateText).not.toHaveBeenCalled();
  });
});
