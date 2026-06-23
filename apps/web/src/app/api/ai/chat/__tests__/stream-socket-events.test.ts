/**
 * Verifies that the page AI chat route delegates streaming lifecycle
 * (registry, DB persistence, socket broadcasts) to createStreamLifecycle and
 * routes chunk/finish/abort/error events through the returned handle.
 *
 * Internal lifecycle behaviors (DB shape, conflict refresh, broadcast ordering)
 * live in stream-lifecycle.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockCreateStreamLifecycle,
  mockLifecyclePushPart,
  mockLifecycleFinish,
  mockBroadcastChatUserMessage,
  mockSaveMessageToDatabase,
  mockGetConversation,
  mockCreateConversation,
} = vi.hoisted(() => ({
  mockCreateStreamLifecycle: vi.fn(),
  mockLifecyclePushPart: vi.fn(),
  mockLifecycleFinish: vi.fn(),
  mockBroadcastChatUserMessage: vi.fn().mockResolvedValue(undefined),
  mockSaveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  mockGetConversation: vi.fn().mockResolvedValue(null), // default: legacy (no row) → broadcast
  mockCreateConversation: vi.fn().mockResolvedValue(undefined),
}));

interface MockUIStreamOptions {
  execute?: (ctx: Record<string, unknown>) => Promise<void> | void;
  onFinish?: (result: { responseMessage: unknown }) => Promise<void> | void;
  originalMessages?: unknown[];
  generateId?: () => string;
}
interface MockStreamTextOptions {
  onChunk?: (ctx: { chunk: Record<string, unknown> }) => void;
  onAbort?: () => void;
}
const captured = vi.hoisted(() => ({
  createUIMessageStreamOptions: {} as MockUIStreamOptions,
  streamTextOptions: {} as MockStreamTextOptions,
}));

vi.mock('@/lib/ai/core/stream-lifecycle', () => ({
  createStreamLifecycle: mockCreateStreamLifecycle,
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn(),
  broadcastChatUserMessage: mockBroadcastChatUserMessage,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
  isMCPAuthResult: vi.fn((r: { tokenType?: string }) => r?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => undefined),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
  canPrincipalEditPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  }),
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
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: <T>(
            resolve?: ((value: (typeof mockDbRow)[]) => T | PromiseLike<T>) | null,
            reject?: ((reason: unknown) => T | PromiseLike<T>) | null,
          ) => Promise.resolve([mockDbRow]).then(resolve, reject),
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([{ displayName: 'Profile User', drivePrompt: null }]),
        })),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: { userId: 'userId', displayName: 'displayName' },
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createSubscriptionRequiredResponse: vi.fn(),
  createAdminRestrictedResponse: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  saveMessageToDatabase: mockSaveMessageToDatabase,
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertDbMessageToUIMessage: vi.fn(),
}));
vi.mock('@/lib/ai/core/mention-processor', () => ({
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
  buildMentionSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildPersonalizationPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  buildPageAITools: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/ai/core/page-tree-context', () => ({
  getPageTreeContext: vi.fn(),
}));
vi.mock('@/lib/ai/core/mcp-tool-converter', () => ({
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn((t: unknown) => t),
}));
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserPersonalization: vi.fn().mockResolvedValue(null),
}));

vi.mock('ai', () => ({
  streamText: vi.fn().mockImplementation((options: MockStreamTextOptions) => {
    captured.streamTextOptions = options;
    return {
      toUIMessageStream: () => (async function* () {})(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      steps: Promise.resolve([]),
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
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: mockGetConversation,
    createConversation: mockCreateConversation,
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackFeature: vi.fn() }));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));

vi.mock('@/lib/mcp', () => ({ getMCPBridge: vi.fn() }));

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
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  isModelAllowedForTier: vi.fn().mockReturnValue(true),
  ONPREM_ALLOWED_PROVIDERS: new Set<string>(['ollama', 'lmstudio', 'azure_openai']),
  DYNAMIC_MODEL_PROVIDERS: new Set<string>(['ollama', 'lmstudio']),
  ADMIN_ONLY_PROVIDERS: new Set<string>([]),
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.3-chat',
  resolveProviderModel: vi.fn((sp: string, sm: string) => ({
    provider: sp && sm ? sp : 'openai',
    model: sm || 'openai/gpt-5.3-chat',
  })),
}));

vi.mock('@/lib/ai/core/tool-utils', () => ({
  mergeToolSets: vi.fn((a: Record<string, unknown>, b: Record<string, unknown>) => ({ ...a, ...b })),
}));

vi.mock('@/lib/ai/tools/finish-tool', () => ({
  finishTool: {},
  FINISH_TOOL_NAME: 'finish',
}));

vi.mock('@/lib/ai/core/stream-pipe-utils', () => ({
  pipeUIMessageStreamStrippingStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { MAX_BROWSER_SESSION_ID_LENGTH } from '@/lib/ai/core/browser-session-id-validation';

const mockDbRow = {
  id: 'page-1',
  title: 'Test Page',
  systemPrompt: null,
  enabledTools: null,
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.3-chat',
  driveId: 'drive-1',
  includeDrivePrompt: false,
  includePageTree: false,
  pageTreeScope: null,
  revision: 0,
  name: 'Auth User',
  currentAiProvider: 'openai',
  currentAiModel: 'openai/gpt-5.3-chat',
  subscriptionTier: 'free',
  timezone: 'UTC',
  displayName: 'Profile User',
  drivePrompt: null,
};

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-1',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = (overrides: { browserSessionId?: string | null; conversationId?: string } = {}) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': '200',
  };
  if (overrides.browserSessionId !== null) {
    headers['X-Browser-Session-Id'] = overrides.browserSessionId ?? 'session-1';
  }
  return new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      chatId: 'page-1',
      conversationId: overrides.conversationId ?? 'conv-1',
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
    }),
  });
};

const mockResponseMessage = {
  id: 'test-message-id',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Hello' }],
};

describe('POST /api/ai/chat — lifecycle handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    mockCreateStreamLifecycle.mockResolvedValue({
      pushPart: mockLifecyclePushPart,
      finish: mockLifecycleFinish,
      getBufferedParts: vi.fn().mockReturnValue([]),
    });
  });

  describe('X-Browser-Session-Id contract', () => {
    it('given a missing X-Browser-Session-Id header, should return 400 before invoking the lifecycle', async () => {
      const response = await POST(makeRequest({ browserSessionId: null }));

      expect(response.status).toBe(400);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    it('given an X-Browser-Session-Id header longer than the cap, should return 400 before invoking the lifecycle', async () => {
      const oversized = 'a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH + 1);
      const response = await POST(makeRequest({ browserSessionId: oversized }));

      expect(response.status).toBe(400);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    it('given an X-Browser-Session-Id header at exactly the cap, should accept and invoke the lifecycle', async () => {
      const maxLength = 'a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH);
      await POST(makeRequest({ browserSessionId: maxLength }));

      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ browserSessionId: maxLength }),
      );
    });
  });

  describe('createStreamLifecycle invocation', () => {
    it('given a new AI stream, should construct the lifecycle with channel, conversation, user, displayName, and browserSessionId', async () => {
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(mockCreateStreamLifecycle).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith({
        messageId: 'test-message-id',
        channelId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Profile User',
        browserSessionId: 'session-7',
      });
    });
  });

  describe('user-message broadcast', () => {
    it('given a POST with a user message, should broadcast chat:user_message after the DB save resolves with the saved message and full envelope', async () => {
      mockGetConversation.mockResolvedValueOnce({ id: 'conv-1', userId: 'user-1', isShared: true });
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(mockBroadcastChatUserMessage).toHaveBeenCalledTimes(1);
      expect(mockBroadcastChatUserMessage).toHaveBeenCalledWith({
        message: { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        pageId: 'page-1',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-1', displayName: 'Profile User', browserSessionId: 'session-7' },
      });
    });

    it('given the user-message DB save rejects, should NOT broadcast chat:user_message', async () => {
      mockSaveMessageToDatabase.mockRejectedValueOnce(new Error('db down'));

      await POST(makeRequest());

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('given broadcastChatUserMessage rejects, should not block the request', async () => {
      mockBroadcastChatUserMessage.mockRejectedValueOnce(new Error('socket dead'));

      await expect(POST(makeRequest())).resolves.toBeDefined();
    });
  });

  describe('conversation privacy gate on broadcast', () => {
    it('should NOT broadcast when conversation row is missing (fail closed)', async () => {
      mockCreateConversation.mockRejectedValueOnce(new Error('db down'));
      mockGetConversation.mockResolvedValueOnce(null);

      await POST(makeRequest({ conversationId: 'conv-1' }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should broadcast when conversation isShared is true', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: 'conv-1', userId: 'other-user', isShared: true,
      });

      await POST(makeRequest({ conversationId: 'conv-1' }));

      expect(mockBroadcastChatUserMessage).toHaveBeenCalledTimes(1);
    });

    it('should suppress broadcast when user owns a private conversation', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: 'conv-1', userId: 'user-1', isShared: false,
      });

      await POST(makeRequest({ conversationId: 'conv-1' }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should suppress broadcast when private conversation is owned by someone else', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: 'conv-1', userId: 'other-user', isShared: false,
      });

      await POST(makeRequest({ conversationId: 'conv-1' }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should omit mentionNotify from saveMessageToDatabase when isShared=false', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: 'conv-1', userId: 'user-1', isShared: false,
      });

      await POST(makeRequest({ conversationId: 'conv-1' }));
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]?.mentionNotify).toBeUndefined();
    });

    it('should include mentionNotify in saveMessageToDatabase when isShared=true', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: 'conv-1', userId: 'user-1', isShared: true,
      });

      await POST(makeRequest({ conversationId: 'conv-1' }));
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]?.mentionNotify).toBeDefined();
    });
  });

  describe('chunk forwarding', () => {
    it('given a text-delta chunk, should forward a text part to lifecycle.pushPart', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'text-delta', text: 'hello', id: 'c1' } });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({ type: 'text', text: 'hello' });
    });

    it('given a tool-call chunk, should forward an input-available tool part to lifecycle.pushPart', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({
        chunk: { type: 'tool-call', toolCallId: 'tc1', toolName: 'list_pages', input: { driveId: 'd1' } },
      });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'input-available',
        input: { driveId: 'd1' },
      });
    });

    it('given a tool-result chunk, should forward an output-available tool part to lifecycle.pushPart', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({
        chunk: {
          type: 'tool-result',
          toolCallId: 'tc1',
          toolName: 'list_pages',
          input: { driveId: 'd1' },
          output: { pages: [{ id: 'p1' }] },
        },
      });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-available',
        input: { driveId: 'd1' },
        output: { pages: [{ id: 'p1' }] },
      });
    });

    it('given a tool-error chunk, should forward an output-error tool part with errorText to lifecycle.pushPart', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({
        chunk: {
          type: 'tool-error',
          toolCallId: 'tc1',
          toolName: 'list_pages',
          input: { driveId: 'd1' },
          error: new Error('drive permission denied'),
        },
      });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-error',
        input: { driveId: 'd1' },
        errorText: 'drive permission denied',
      });
    });

    it('given a chunk type out of v1 multicast scope, should not forward anything', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'finish-step' } });

      expect(mockLifecyclePushPart).not.toHaveBeenCalled();
    });
  });

  describe('execute-end durable persistence', () => {
    it('given buffered parts exist, should persist the assistant message before lifecycle.finish()', async () => {
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'server reply' }]),
      });

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeDefined();
      expect(assistantSave?.[0]).toMatchObject({
        messageId: 'test-message-id',
        pageId: 'page-1',
        conversationId: 'conv-1',
        userId: null,
        role: 'assistant',
      });
    });

    it('given buffered parts are empty, should NOT persist from the execute path', async () => {
      // beforeEach already mocks getBufferedParts to return [] — no override needed
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeUndefined();
    });

    it('given saveMessageToDatabase rejects from the execute path, should not propagate the error', async () => {
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'will fail' }]),
      });

      await POST(makeRequest());
      // User message save has already run; next call is the execute-end assistant persist
      mockSaveMessageToDatabase.mockRejectedValueOnce(new Error('db down'));

      await expect(
        captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() }),
      ).resolves.toBeUndefined();
    });
  });

  describe('finish forwarding', () => {
    it('given onFinish runs, should call lifecycle.finish(false)', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockLifecycleFinish).toHaveBeenCalledWith(false);
    });

    it('given onAbort fires, should call lifecycle.finish(true)', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();

      expect(mockLifecycleFinish).toHaveBeenCalledWith(true);
    });

    it('given createUIMessageStream throws, should call lifecycle.finish(true)', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      expect(mockLifecycleFinish).toHaveBeenCalledWith(true);
    });

    it('given the outer route handler errors after lifecycle init, should call lifecycle.finish(true)', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('outer boom');
      });

      await POST(makeRequest());

      const calls = mockLifecycleFinish.mock.calls.filter(([aborted]) => aborted === true);
      expect(calls.length).toBeGreaterThan(0);
    });

    it('given an error throws after lifecycle creation, should call lifecycle.finish(true) from the outer catch', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('post-lifecycle boom');
      });

      await POST(makeRequest());

      const aborted = mockLifecycleFinish.mock.calls.filter(([flag]) => flag === true);
      expect(aborted.length).toBeGreaterThan(0);
    });
  });
});
