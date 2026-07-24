import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Route-level regression test for GitHub-integration/sandbox-tool suppression
// in 'search' tool-exposure mode.
//
// The bug this guards against: `resolvePageAgentIntegrationTools` needs the
// PRE-exposure tool set to detect whether the sandbox git/gh CLI toolkit is
// active (search mode moves non-core tools, including all sandbox tools,
// behind execute_tool — hiding their names from a top-level key scan). A
// prior implementation captured the tool set AFTER `applyToolExposureMode`
// ran, so suppression silently never fired in search mode. `resolveThe
// PageAgentIntegrationTools` is mocked here (its own suppression logic is
// covered by integration-tool-resolver.test.ts) — this test only asserts on
// what the ROUTE passes as `currentTools`, which is the part a resolver-level
// unit test cannot observe.
// ============================================================================

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
    toolExposureMode: 'search',
    aiProvider: 'openai',
    aiModel: 'openai/gpt-5.3-chat',
    driveId: 'drive_A',
    includeDrivePrompt: false,
    includePageTree: false,
    pageTreeScope: null,
    revision: 0,
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
  };
});
// exists/sql: globalConversationRepository's module-scope `hasMessages` query
// (now reachable transitively via stream-takeover -> materialize-interrupted-stream
// -> global-conversation-repository, #2153) needs both or the module throws on import.
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  exists: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
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
// git_clone stands in for the sandbox git/gh CLI toolkit — a real sandbox
// toolkit registers ~56 tool names, but only one is needed to prove
// suppression sees it. list_pages is a non-sandbox, non-core tool so it gets
// deferred behind execute_tool in search mode alongside git_clone.
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    git_clone: { description: 'git_clone' },
    list_pages: { description: 'list_pages' },
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
  TOOL_DISCOVERY_PROMPT: 'discover tools',
  buildNonCoreToolNamesPrompt: vi.fn().mockReturnValue(''),
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
// Phase 6 (#2166): the route now derives a Machine Pane binding for every
// request. None of these requests carry a machine-bound conversationId, so
// this resolves to null (not a machine-bound pane) — the real DB-backed
// deps builder is stubbed out since the pure core itself is fully mocked.
vi.mock('@pagespace/lib/services/machines/machine-pane-binding', () => ({
  deriveMachinePaneBinding: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ai/machine-pane/machine-pane-binding-runtime', () => ({
  buildMachinePaneBindingDeps: vi.fn(() => ({})),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config) => config),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('generated_id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
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
  STREAM_ID_HEADER: 'x-stream-id',
}));

vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true }),
  hasFileParts: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn(),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

// The resolver itself (and its suppression logic) is unit-tested in
// integration-tool-resolver.test.ts. This test only needs to observe what
// the route passes as `currentTools`.
vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { resolvePageAgentIntegrationTools } from '@/lib/ai/core/integration-tool-resolver';

const mockUserId = 'user_123';
const chatId = 'page_123'; // in drive_A per db mock above

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
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
    }),
  });
};

describe('POST /api/ai/chat - GitHub suppression sees sandbox tools in search mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the pre-exposure tool set (including sandbox tools) to resolvePageAgentIntegrationTools even in search mode', async () => {
    const auth = mockWebAuth(mockUserId);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    await POST(createChatRequest());

    expect(resolvePageAgentIntegrationTools).toHaveBeenCalledTimes(1);
    const call = vi.mocked(resolvePageAgentIntegrationTools).mock.calls[0]![0];
    // In search mode, git_clone/list_pages are moved behind execute_tool and
    // vanish as top-level keys — this assertion only passes if the route
    // captured currentTools BEFORE applyToolExposureMode ran.
    expect(call.currentTools).toHaveProperty('git_clone');
    expect(call.currentTools).toHaveProperty('list_pages');
  });
});
