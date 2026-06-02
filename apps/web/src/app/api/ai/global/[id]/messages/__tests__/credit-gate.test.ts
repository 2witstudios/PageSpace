/**
 * Prepaid credit-gate enforcement + usage-logging durability for
 * POST /api/ai/global/[id]/messages.
 *
 * - The gate is consulted before the model is invoked: an out-of-credits user
 *   gets a 402 and neither the stream nor the lifecycle is started.
 * - R4: AIMonitoring.trackUsage is ALWAYS called from onFinish, even when the
 *   provider returns no usage metadata, so the orphan-sweep has a row to bill.
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
}));

vi.mock('@/lib/ai/core/stream-lifecycle', () => ({
  createStreamLifecycle: mockCreateStreamLifecycle,
}));

vi.mock('@/lib/websocket', () => ({
  broadcastUsageEvent: vi.fn().mockResolvedValue(undefined),
  broadcastChatUserMessage: mockBroadcastChatUserMessage,
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
  const insert = vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })) }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) }));
  return { db: { select, insert, update } };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), gt: vi.fn(), lt: vi.fn(),
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

vi.mock('@/lib/subscription/usage-service', () => ({
  incrementUsage: vi.fn().mockResolvedValue({ currentCount: 1, limit: 100, remainingCalls: 99, success: true }),
  getCurrentUsage: vi.fn().mockResolvedValue({ success: true, remainingCalls: 100, currentCount: 0, limit: 100 }),
  getUserUsageSummary: vi.fn().mockResolvedValue({
    subscriptionTier: 'free',
    standard: { current: 0, limit: 100, remaining: 100 },
    pro: { current: 0, limit: 0, remaining: 0 },
  }),
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({ createRateLimitResponse: vi.fn() }));

// The credit gate under test. Default: allowed. Individual tests override.
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'glm-4.5-air' }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
  pageSpaceTools: {},
  corePageSpaceTools: {},
  TOOL_DISCOVERY_PROMPT: 'TOOLS: mock',
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertGlobalAssistantMessageToUIMessage: vi.fn(),
  saveGlobalAssistantMessageToDatabase: mockSaveGlobalAssistantMessageToDatabase,
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
  buildMentionSystemPrompt: vi.fn().mockReturnValue(''),
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildNonCoreToolNamesPrompt: vi.fn().mockReturnValue(''),
  buildAgentAwarenessPrompt: vi.fn().mockResolvedValue(''),
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  getPageTreeContext: vi.fn().mockResolvedValue(''),
  getDriveListSummary: vi.fn().mockResolvedValue(''),
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn((t: unknown) => t),
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

vi.mock('@paralleldrive/cuid2', () => ({ createId: vi.fn().mockReturnValue('test-message-id') }));
vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`) }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
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
vi.mock('@/lib/ai/core/model-capabilities', () => ({ hasVisionCapability: vi.fn().mockReturnValue(true) }));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  getPageSpaceModelTier: vi.fn().mockReturnValue('standard'),
  getProviderTier: vi.fn().mockReturnValue('standard'),
}));
vi.mock('@/lib/ai/core/tool-utils', () => ({
  mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })),
}));
vi.mock('@/lib/ai/tools/finish-tool', () => ({ finishTool: {}, FINISH_TOOL_NAME: 'finish' }));
vi.mock('@/lib/ai/tools/tool-search-tool', () => ({ createToolSearchTool: vi.fn().mockReturnValue({}) }));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { streamText } from 'ai';

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = () =>
  new Request('https://example.com/api/ai/global/conv-1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', 'X-Browser-Session-Id': 'session-1' },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      selectedProvider: 'pagespace',
      selectedModel: 'glm-4.5-air',
    }),
  });

const makeContext = () => ({ params: Promise.resolve({ id: 'conv-1' }) });

const mockResponseMessage = {
  id: 'test-message-id',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Hello' }],
};

describe('POST /api/ai/global/[id]/messages — prepaid credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    captured.totalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
    mockCreateStreamLifecycle.mockResolvedValue({ pushPart: mockLifecyclePushPart, finish: mockLifecycleFinish });
  });

  it('returns 402 out_of_credits and never starts the stream when the gate denies', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toBe('out_of_credits');
    expect(streamText).not.toHaveBeenCalled();
    expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    // Side-effect-free denial: the user message must NOT be persisted, so a
    // retry after a 402 cannot leave a visible user-only message.
    expect(mockSaveGlobalAssistantMessageToDatabase).not.toHaveBeenCalled();
  });

  it('does not block with a 402 when the gate allows', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'ok' });

    const response = await POST(makeRequest(), makeContext());

    expect(canConsumeAI).toHaveBeenCalled();
    expect(response.status).not.toBe(402);
  });
});

describe('POST /api/ai/global/[id]/messages — usage logging durability (R4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
    mockCreateStreamLifecycle.mockResolvedValue({ pushPart: mockLifecyclePushPart, finish: mockLifecycleFinish });
  });

  it('calls AIMonitoring.trackUsage even when the provider returns no usage metadata', async () => {
    // Provider returns no usage — the orphan-sweep depends on a row still being written.
    captured.totalUsage = undefined;

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect(call.model).toBe('glm-4.5-air');
    expect(call.totalTokens).toBeUndefined();
  });

  it('still logs the resolved model with token counts when usage is present', async () => {
    captured.totalUsage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect({ model: call.model, totalTokens: call.totalTokens }).toEqual({ model: 'glm-4.5-air', totalTokens: 20 });
  });
});
