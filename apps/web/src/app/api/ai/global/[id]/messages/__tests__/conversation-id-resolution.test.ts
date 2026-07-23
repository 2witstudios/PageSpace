/**
 * POST /api/ai/global/[id]/messages must resolve conversation identity from
 * the request BODY when present, not solely from the URL path segment.
 *
 * Root cause this guards against: `useChat`'s internal Chat instance is
 * constructed once (per PR #1739's stable-id fix, needed to avoid clobbering
 * messages) and never re-applies a later `transport` — so the URL baked into
 * the transport at first construction is permanently reused, even after the
 * client's conversation-identity state (correctly) moves on. Trusting
 * `body.conversationId` over the frozen URL segment is what makes "New Chat"
 * and history-select actually take effect on the next send.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockCreateStreamLifecycle,
  mockLifecyclePushPart,
  mockLifecycleFinish,
  mockBroadcastChatUserMessage,
  mockSaveGlobalAssistantMessageToDatabase,
} = vi.hoisted(() => ({
  mockCreateStreamLifecycle: vi.fn(),
  mockLifecyclePushPart: vi.fn(),
  mockLifecycleFinish: vi.fn(),
  mockBroadcastChatUserMessage: vi.fn().mockResolvedValue(undefined),
  mockSaveGlobalAssistantMessageToDatabase: vi.fn().mockResolvedValue(undefined),
}));

interface MockUIStreamOptions {
  execute?: (ctx: Record<string, unknown>) => Promise<void> | void;
  onFinish?: (result: { responseMessage: unknown }) => Promise<void> | void;
}
interface MockStreamTextOptions {
  onChunk?: (ctx: { chunk: Record<string, unknown> }) => void;
  onAbort?: () => void;
}
const captured = vi.hoisted(() => ({
  createUIMessageStreamOptions: {} as MockUIStreamOptions,
  streamTextOptions: {} as MockStreamTextOptions,
  totalUsage: undefined as unknown,
  steps: [] as unknown,
}));

vi.mock('@/lib/ai/core/stream-lifecycle', () => ({
  createStreamLifecycle: mockCreateStreamLifecycle,
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn().mockResolvedValue(undefined),
  broadcastChatUserMessage: mockBroadcastChatUserMessage,
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastGlobalConversationAdded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logPerformance: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const mockConversation = {
  id: 'conv-1',
  userId: 'user-1',
  title: 'Test Conversation',
  type: 'global',
  contextId: null,
  isActive: true,
};
const mockUserProfile = { displayName: 'Display User' };
const mockAuthUser = { name: 'Auth User', subscriptionTier: 'free' };

vi.mock('@pagespace/db/db', () => {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const tableLabel = table as { __label?: string } | undefined;
      const isUsers = tableLabel?.__label === 'users';
      return {
        where: vi.fn(() => ({
          then: <T>(
            resolve?: ((value: unknown[]) => T | PromiseLike<T>) | null,
            reject?: ((reason: unknown) => T | PromiseLike<T>) | null,
          ) => Promise.resolve(isUsers ? [mockAuthUser] : [mockConversation]).then(resolve, reject),
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue(isUsers ? [mockAuthUser] : [mockUserProfile]),
        })),
      };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]) })),
    })),
  }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }));
  // startGenerationExclusive's advisory lock: always free, so takeover+lifecycle-create run
  // exactly as before. Its own retry/degrade behavior is covered by
  // start-generation-exclusive.test.ts — this file only verifies this route wires it in.
  const getAdvisoryLockPool = vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
      release: vi.fn(),
    })),
  }));
  return { db: { select, insert, update }, getAdvisoryLockPool };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), gt: vi.fn(), lt: vi.fn(),
  exists: vi.fn((sub) => ({ type: 'exists', sub })),
}));

vi.mock('../resolve-or-create-conversation', () => ({
  resolveOrCreateConversation: vi.fn().mockResolvedValue({
    conversation: { id: 'conv-1', userId: 'user-1', title: 'Test Conversation', type: 'global', contextId: null, isActive: true, createdAt: new Date('2024-01-01') },
    isNew: false,
  }),
  ConversationOwnershipError: class ConversationOwnershipError extends Error {},
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'id', drivePrompt: 'drivePrompt' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { __label: 'users', id: 'id', name: 'name', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'id', userId: 'userId', isActive: 'isActive', lastMessageAt: 'lastMessageAt', updatedAt: 'updatedAt', title: 'title' },
  messages: { conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt', id: 'id' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: { __label: 'userProfiles', userId: 'userId', displayName: 'displayName' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  createAdminRestrictedResponse: vi.fn(),
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'openai', modelName: 'openai/gpt-5.3-chat' }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
  corePageSpaceTools: {},
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  TOOL_DISCOVERY_PROMPT: 'TOOLS: mock',
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildNonCoreToolNamesPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertGlobalAssistantMessageToUIMessage: vi.fn(),
  saveGlobalAssistantMessageToDatabase: mockSaveGlobalAssistantMessageToDatabase,
}));
vi.mock('@/lib/ai/core/mention-processor', () => ({
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
  buildMentionSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/agent-awareness', () => ({
  buildAgentAwarenessPrompt: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  filterToolsForImageGen: vi.fn((t) => t),
}));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn().mockResolvedValue(''),
  getDriveListSummary: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ai/core/mcp-tool-converter', () => ({
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn((t: unknown) => t),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserPersonalization: vi.fn().mockResolvedValue(null),
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));

vi.mock('@/lib/ai/core/stub-tools', () => ({
  CORE_TOOL_NAMES: new Set(['list_drives', 'list_pages', 'read_page', 'get_page_details', 'create_page', 'replace_lines', 'regex_search', 'multi_drive_search']),
}));
vi.mock('@/lib/ai/tools/execute-tool', () => ({ createExecuteTool: vi.fn().mockReturnValue({}) }));

vi.mock('ai', () => ({
  streamText: vi.fn().mockImplementation((options: MockStreamTextOptions) => {
    captured.streamTextOptions = options;
    return {
      toUIMessageStream: () => (async function* () {})(),
      get totalUsage() { return Promise.resolve(captured.totalUsage); },
      get steps() { return Promise.resolve(captured.steps); },
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({ messages: [] }),
    };
  }),
  convertToModelMessages: vi.fn().mockReturnValue([]),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(() => () => false),
  tool: vi.fn((config: unknown) => config),
  createUIMessageStream: vi.fn().mockImplementation((options: MockUIStreamOptions) => {
    captured.createUIMessageStreamOptions = options;
    return {};
  }),
  createUIMessageStreamResponse: vi.fn().mockReturnValue(new Response('', { status: 200 })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('test-message-id'),
}));
vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`) }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));
vi.mock('@pagespace/lib/monitoring/ai-context-calculator', () => ({
  calculateTotalContextSize: vi.fn().mockReturnValue({
    totalTokens: 0, messageCount: 0, systemPromptTokens: 0, toolDefinitionTokens: 0,
    conversationTokens: 0, wasTruncated: false, truncationStrategy: undefined, messageIds: [],
  }),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({ isMember: false, role: null }),
}));
vi.mock('@/lib/utils/query-params', () => ({ parseBoundedIntParam: vi.fn().mockReturnValue(50) }));
vi.mock('@/lib/mcp', () => ({ getMCPBridge: vi.fn() }));
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn().mockReturnValue({ streamId: 'stream_123', signal: new AbortController().signal }),
  removeStream: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));
vi.mock('@/lib/ai/core/stream-pipe-utils', () => ({
  pipeUIMessageStreamStrippingStart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true }),
  hasFileParts: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-image-preview',
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  isModelAllowedForTier: vi.fn().mockReturnValue(true),
  ADMIN_ONLY_PROVIDERS: new Set<string>([]),
  resolveProviderModel: vi.fn((sp: string, sm: string) => ({
    provider: sp && sm ? sp : 'openai',
    model: sm || 'openai/gpt-5.3-chat',
  })),
}));
vi.mock('@/lib/ai/core/tool-utils', () => ({
  mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })),
}));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));
vi.mock('@/lib/ai/tools/tool-search-tool', () => ({ createToolSearchTool: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/ai/core/compaction/prepare-context', () => ({
  prepareConversationContext: vi.fn().mockImplementation(
    ({ messages }: { messages: unknown[] }) =>
      Promise.resolve({ messages, scheduleCompaction: () => {}, pendingCompaction: null }),
  ),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { resolveOrCreateConversation } from '../resolve-or-create-conversation';

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/global/url-conv-id/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '400', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
      ...body,
    }),
  });

// The URL segment is what a frozen (stale) useChat transport would still be
// pointed at — a real request from an affected browser session sends this
// value in the URL, but the FRESH conversationId in the body.
const makeContext = () => ({ params: Promise.resolve({ id: 'url-conv-id' }) });

describe('POST /api/ai/global/[id]/messages — conversation identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    captured.totalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    mockCreateStreamLifecycle.mockResolvedValue({ pushPart: mockLifecyclePushPart, finish: mockLifecycleFinish });
  });

  it('given the body includes a conversationId different from the URL segment, should resolve using the BODY id, not the URL id', async () => {
    await POST(makeRequest({ conversationId: 'body-conv-id' }), makeContext());

    expect(resolveOrCreateConversation).toHaveBeenCalledWith('user-1', 'body-conv-id');
  });

  it('given the body omits conversationId, should fall back to the URL segment', async () => {
    await POST(makeRequest({}), makeContext());

    expect(resolveOrCreateConversation).toHaveBeenCalledWith('user-1', 'url-conv-id');
  });
});
