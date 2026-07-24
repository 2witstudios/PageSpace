import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import type { SessionAuthResult, MCPAuthResult } from '@/lib/auth';

// ============================================================================
// Account-level-only tool listing tests for POST /api/ai/chat
//
// Verifies that create_drive (account-level-only, cannot be used by a
// drive-scoped MCP token) is excluded from the tool list built for a scoped
// MCP token, while an unscoped/session caller still sees it. Spies on the
// REAL filterToolsForMcpScope (via importOriginal) so we assert on its actual
// isScoped argument and return value at the point the route builds baseTools,
// without needing to mock the entire downstream streaming pipeline.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  isMCPAuthResult: vi.fn((result: { tokenType?: string }) => result?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn((auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? []),
  isScopedMCPAuth: vi.fn((auth: { allowedDriveIds?: string[] }) => (auth.allowedDriveIds ?? []).length > 0),
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
// pageSpaceTools includes create_drive so filtering behavior is observable.
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    create_drive: { description: 'create_drive' },
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
}));
// Spy on the REAL implementation so we can assert on its actual behavior
// (isScoped argument + filtered return value), instead of stubbing it away.
vi.mock('@/lib/ai/core/tool-filtering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../lib/ai/core/tool-filtering')>();
  return {
    ...actual,
    filterToolsForMcpScope: vi.fn(actual.filterToolsForMcpScope),
  };
});
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
vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { filterToolsForMcpScope } from '@/lib/ai/core/tool-filtering';

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

const mockMCPAuth = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'mcp-token-id',
  role: 'user',
  adminRoleVersion: 0,
  allowedDriveIds,
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

describe('POST /api/ai/chat - account-level-only tool listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes create_drive from the tool list for a drive-scoped MCP token', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    await POST(createChatRequest());

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), true);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).not.toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });

  it('includes create_drive in the tool list for session (unscoped) auth', async () => {
    const auth = mockWebAuth(mockUserId);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    await POST(createChatRequest());

    expect(filterToolsForMcpScope).toHaveBeenCalledWith(expect.anything(), false);
    const filtered = vi.mocked(filterToolsForMcpScope).mock.results[0]?.value as Record<string, unknown>;
    expect(filtered).toHaveProperty('create_drive');
    expect(filtered).toHaveProperty('list_pages');
  });
});
