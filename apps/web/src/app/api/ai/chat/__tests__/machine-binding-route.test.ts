import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Machine Pane binding tests for POST /api/ai/chat (Phase 6, issue #2166)
//
// Verifies the route's wiring of deriveMachinePaneBinding (Phase 5 pure core):
//  - bound conversation -> machineBinding + activeMachine seeded into
//    experimental_context, switch_machine/list_machines dropped from tools
//  - row.machineId !== chatId -> 400 before streaming
//  - non-bound conversation -> derivation null, passthrough unchanged
//
// Mirrors mcp-scope-tool-filtering.test.ts's idiom: mocks every module the
// route imports, calls the real POST with a real Request, and spies on the
// REAL filterToolsForMachineBinding (via importOriginal) to assert on its
// actual isBound argument and return value.
// ============================================================================

const deriveMachinePaneBindingMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  isMCPAuthResult: vi.fn(() => false),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  canPrincipalEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@test.com', actorDisplayName: 'Test' }),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logPerformance: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => {
  const pageRow = {
    id: 'page_123',
    title: 'Test Page',
    systemPrompt: null,
    enabledTools: null,
    aiProvider: 'openai',
    aiModel: 'openai/gpt-5.3-chat',
    driveId: 'drive_A',
    includeDrivePrompt: false,
    includePageTree: false,
    pageTreeScope: null,
    revision: 0,
    type: 'AI_CHAT',
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const result = Promise.resolve([pageRow]);
            return Object.assign(result, {
              orderBy: vi.fn().mockResolvedValue([]),
              limit: vi.fn().mockResolvedValue([]),
            });
          }),
        })),
      })),
    },
    // Accessed by start-generation-exclusive's advisory lock (real, unmocked
    // implementation) — its own error handling degrades to running unlocked
    // when the pool/lock query fails, which a bare object triggers harmlessly.
    getAdvisoryLockPool: vi.fn(() => ({})),
  };
});
// exists/sql: globalConversationRepository's module-scope `hasMessages` query
// (now reachable transitively via stream-takeover -> materialize-interrupted-stream
// -> global-conversation-repository, #2153) needs both or the module throws on import.
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  ne: vi.fn(),
  desc: vi.fn(),
  exists: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt', status: 'status' },
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
  createAdminRestrictedResponse: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn(),
  broadcastAiStreamStart: vi.fn().mockResolvedValue(undefined),
  broadcastAiStreamComplete: vi.fn().mockResolvedValue(undefined),
  broadcastChatUserMessage: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
// pageSpaceTools includes switch_machine/list_machines so filtering behavior is observable.
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    switch_machine: { description: 'switch_machine' },
    list_machines: { description: 'list_machines' },
    read_page: { description: 'read_page' },
  },
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  saveMessageToDatabase: vi.fn(),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertDbMessageToUIMessage: vi.fn(),
}));
vi.mock('@/lib/ai/core/mention-processor', () => ({
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildPersonalizationPrompt: vi.fn().mockReturnValue(''),
}));
// Spy on the REAL implementation so we can assert on its actual behavior
// (isBound argument + filtered return value), instead of stubbing it away.
vi.mock('@/lib/ai/core/tool-filtering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../lib/ai/core/tool-filtering')>();
  return {
    ...actual,
    filterToolsForMachineBinding: vi.fn(actual.filterToolsForMachineBinding),
  };
});
// The session family's production wiring reaches the agent-terminal and
// workspace stores; the route's job — which this file tests — is only WHETHER
// it registers them, so the runtime is stubbed with a recognisable stand-in.
vi.mock('@/lib/ai/tools/session-tools-runtime', () => ({
  buildSessionTools: vi.fn(() => ({
    list_sessions: {},
    add_session: {},
    move_session: {},
    kill_session: {},
    read_session: {},
    send_session: {},
  })),
}));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn(),
}));
vi.mock('@/lib/ai/core/mcp-tool-converter', () => ({
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn(),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserPersonalization: vi.fn().mockResolvedValue(null),
}));

const streamTextMock = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config) => config),
  // Real createUIMessageStream runs `execute` as a detached producer (the
  // route never awaits it — the returned stream is consumed by piping into
  // the HTTP response). Mirror that: fire it without awaiting, so the route
  // under test returns the same way it does in production, and this file's
  // tests poll (vi.waitFor) for streamText to have been invoked once its
  // microtasks settle.
  createUIMessageStream: vi.fn((opts: { execute?: (args: { writer: { write: () => void } }) => Promise<void> }) => {
    void opts.execute?.({ writer: { write: vi.fn() } })?.catch(() => {});
    return {};
  }),
  createUIMessageStreamResponse: vi.fn(() => new Response(null, { status: 200 })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated_id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
  isCuid: vi.fn(() => true),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackFeature: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn(),
    trackToolUsage: vi.fn(),
  },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));

vi.mock('@/lib/mcp', () => ({
  getMCPBridge: vi.fn(),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn().mockReturnValue({ streamId: 'stream_123', signal: new AbortController().signal }),
  removeStream: vi.fn(),
  attachStreamFinisher: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));

vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true }),
  hasFileParts: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn(),
  hasVisionCapability: vi.fn().mockReturnValue(true),
  DEFAULT_IMAGE_MODEL: 'default-image-model',
}));
vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn().mockResolvedValue(null),
    hasConflictingMessageOwner: vi.fn().mockResolvedValue(false),
    createConversation: vi.fn().mockResolvedValue(undefined),
  },
}));

// The module under test in this file: deriveMachinePaneBinding is the Phase 5
// pure core the route must call. buildMachinePaneBindingDeps is its DB-backed
// wiring (Phase 5 runtime shell) — stubbed to a no-op object since the pure
// core itself is fully mocked below.
vi.mock('@pagespace/lib/services/machines/machine-pane-binding', () => ({
  deriveMachinePaneBinding: (...args: unknown[]) => deriveMachinePaneBindingMock(...args),
}));
vi.mock('@/lib/ai/machine-pane/machine-pane-binding-runtime', () => ({
  buildMachinePaneBindingDeps: vi.fn(() => ({})),
}));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { filterToolsForMachineBinding, SESSION_FAMILY_TOOL_NAMES } from '@/lib/ai/core/tool-filtering';

const mockUserId = 'user_123';
const chatId = 'page_123'; // in drive_A per db mock above
const conversationId = 'conversation_abc';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const createChatRequest = () => {
  return new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [
        { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ],
      chatId,
      conversationId,
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
    }),
  });
};

describe('POST /api/ai/chat - machine-pane binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    streamTextMock.mockReturnValue({});
  });

  it('injects machineBinding + seeds activeMachine, and drops switch_machine/list_machines when bound', async () => {
    const self = { kind: 'machine' as const, machineId: chatId, cwd: '/workspace' };
    deriveMachinePaneBindingMock.mockResolvedValue({
      ok: true,
      binding: { self, handles: [self] },
    });

    await POST(createChatRequest());

    expect(deriveMachinePaneBindingMock).toHaveBeenCalledWith(
      { chatId, conversationId },
      expect.anything(),
    );

    expect(filterToolsForMachineBinding).toHaveBeenCalledWith(expect.anything(), true);
    const filtered = vi.mocked(filterToolsForMachineBinding).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).not.toHaveProperty('switch_machine');
    expect(filtered).not.toHaveProperty('list_machines');
    expect(filtered).toHaveProperty('read_page');

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
    const streamTextArgs = streamTextMock.mock.calls[0]?.[0] as { experimental_context?: Record<string, unknown> };
    expect(streamTextArgs.experimental_context?.machineBinding).toEqual({ self, handles: [self] });
    expect(streamTextArgs.experimental_context?.activeMachine).toEqual({
      kind: 'existing',
      machineId: chatId,
    });
  });

  // The bound conversation's system prompt has to describe a NODE SCOPE, not a
  // single checkout: which node it lives at, what it may address beneath it,
  // and where to discover those nodes. "list_sessions" is a frozen contract
  // string — the tool itself lands with the session family.
  describe('MACHINE BINDING system prompt', () => {
    const project = { kind: 'project' as const, machineId: chatId, project: 'repo', cwd: '/workspace/projects/repo' };
    const branch = {
      kind: 'branch' as const,
      machineId: chatId,
      project: 'repo',
      branch: 'feature',
      cwd: '/workspace/repo',
      branchSandbox: { machineBranchId: 'branch-1', sandboxId: 'sbx-1' },
    };

    async function systemPromptFor(binding: unknown): Promise<string> {
      streamTextMock.mockClear();
      deriveMachinePaneBindingMock.mockResolvedValue({ ok: true, binding });
      await POST(createChatRequest());
      await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
      return (streamTextMock.mock.calls[0]?.[0] as { system?: string }).system ?? '';
    }

    it('given a machine-root binding, should state the node scope, the target syntax, and reference list_sessions', async () => {
      const self = { kind: 'machine' as const, machineId: chatId, cwd: '/workspace' };
      const prompt = await systemPromptFor({ self, handles: [self, project, branch] });
      expect(prompt).toContain('MACHINE BINDING (this conversation)');
      expect(prompt).toContain('machine root');
      expect(prompt).toContain('target');
      expect(prompt).toContain('list_sessions');
      expect(prompt).toContain('switch_machine');
    });

    it('given a branch binding, should name the branch node and say nothing lies beneath it', async () => {
      const prompt = await systemPromptFor({ self: branch, handles: [branch] });
      expect(prompt).toContain('branch "feature"');
      expect(prompt).toContain('project "repo"');
      expect(prompt).toContain('/workspace/repo');
      expect(prompt).toContain('list_sessions');
    });

    it('given a project binding, should name the project node and its addressable branches', async () => {
      const prompt = await systemPromptFor({ self: project, handles: [project, branch] });
      expect(prompt).toContain('project "repo"');
      expect(prompt).toContain('branch: "feature"');
    });
  });

  // The session family is the bound conversation's whole orchestration
  // surface — and is meaningless without a handle set to resolve its targets
  // against. A drive agent's tool set must therefore be byte-unchanged by it.
  it('registers the session family for a bound conversation', async () => {
    const self = { kind: 'machine' as const, machineId: chatId, cwd: '/workspace' };
    deriveMachinePaneBindingMock.mockResolvedValue({ ok: true, binding: { self, handles: [self] } });

    await POST(createChatRequest());

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
    const tools = (streamTextMock.mock.calls[0]?.[0] as { tools?: Record<string, unknown> }).tools ?? {};
    expect(Object.keys(tools).filter((name) => SESSION_FAMILY_TOOL_NAMES.includes(name)).sort()).toEqual(
      [...SESSION_FAMILY_TOOL_NAMES].sort(),
    );
  });

  it('leaves a non-bound conversation\'s tool set free of the session family', async () => {
    deriveMachinePaneBindingMock.mockResolvedValue(null);

    await POST(createChatRequest());

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
    const tools = (streamTextMock.mock.calls[0]?.[0] as { tools?: Record<string, unknown> }).tools ?? {};
    expect(Object.keys(tools).filter((name) => SESSION_FAMILY_TOOL_NAMES.includes(name))).toEqual([]);
  });

  it('returns 400 before streaming when row.machineId !== chatId', async () => {
    deriveMachinePaneBindingMock.mockResolvedValue({
      ok: false,
      reason: 'binding_page_mismatch',
    });

    const response = await POST(createChatRequest());

    expect(response.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('leaves behavior unchanged for a non-bound conversation (derivation null)', async () => {
    deriveMachinePaneBindingMock.mockResolvedValue(null);

    await POST(createChatRequest());

    expect(filterToolsForMachineBinding).toHaveBeenCalledWith(expect.anything(), false);
    const filtered = vi.mocked(filterToolsForMachineBinding).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).toHaveProperty('switch_machine');
    expect(filtered).toHaveProperty('list_machines');

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalled());
    const streamTextArgs = streamTextMock.mock.calls[0]?.[0] as { experimental_context?: Record<string, unknown> };
    expect(streamTextArgs.experimental_context?.machineBinding).toBeUndefined();
    expect(streamTextArgs.experimental_context?.activeMachine).toBeUndefined();
  });
});
