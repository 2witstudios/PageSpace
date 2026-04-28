/**
 * Tests for Task 3: stream socket events wired into the AI chat route.
 *
 * Verifies that route.ts calls register → broadcastAiStreamStart before streaming,
 * pushes text-delta chunks to the registry, and calls finish + broadcastAiStreamComplete
 * on completion or abort. Also verifies the finally path on route error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Hoisted mocks (referenced inside vi.mock factories)
// ============================================================================

const {
  mockRegistryRegister,
  mockRegistryPush,
  mockRegistryFinish,
  mockBroadcastAiStreamStart,
  mockBroadcastAiStreamComplete,
} = vi.hoisted(() => ({
  mockRegistryRegister: vi.fn(),
  mockRegistryPush: vi.fn(),
  mockRegistryFinish: vi.fn(),
  mockBroadcastAiStreamStart: vi.fn().mockResolvedValue(undefined),
  mockBroadcastAiStreamComplete: vi.fn().mockResolvedValue(undefined),
}));

// Captured AI SDK callbacks
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

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('@/lib/ai/core/stream-multicast-registry', () => ({
  streamMulticastRegistry: {
    register: mockRegistryRegister,
    push: mockRegistryPush,
    finish: mockRegistryFinish,
    getMeta: vi.fn(),
    subscribe: vi.fn(),
  },
  StreamMulticastRegistry: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastUsageEvent: vi.fn(),
  broadcastAiStreamStart: mockBroadcastAiStreamStart,
  broadcastAiStreamComplete: mockBroadcastAiStreamComplete,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
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
          // supports direct await (pages, users), .orderBy() (chatMessages), and .limit() (userProfiles, drives)
          then: <T>(
            resolve?: ((value: (typeof mockDbRow)[]) => T | PromiseLike<T>) | null,
            reject?: ((reason: unknown) => T | PromiseLike<T>) | null,
          ) => Promise.resolve([mockDbRow]).then(resolve, reject),
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([{ displayName: 'Test User', drivePrompt: null }]),
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

vi.mock('@/lib/subscription/usage-service', () => ({
  incrementUsage: vi.fn().mockResolvedValue({ currentCount: 1, limit: 100, remainingCalls: 99, success: true }),
  getCurrentUsage: vi.fn().mockResolvedValue({ success: true, remainingCalls: 100, currentCount: 0, limit: 100 }),
  getUserUsageSummary: vi.fn().mockResolvedValue({
    subscriptionTier: 'free',
    standard: { current: 0, limit: 100, remaining: 100 },
    pro: { current: 0, limit: 0, remaining: 0 },
  }),
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn().mockReturnValue(false),
  createRateLimitResponse: vi.fn(),
  createSubscriptionRequiredResponse: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {} }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
  getUserOpenRouterSettings: vi.fn(),
  getUserGoogleSettings: vi.fn(),
  getDefaultPageSpaceSettings: vi.fn(),
  getUserOpenAISettings: vi.fn(),
  getUserAnthropicSettings: vi.fn(),
  getUserXAISettings: vi.fn(),
  getUserOllamaSettings: vi.fn(),
  getUserLMStudioSettings: vi.fn(),
  getUserGLMSettings: vi.fn(),
  pageSpaceTools: {},
  extractMessageContent: vi.fn().mockReturnValue('test content'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractToolResults: vi.fn().mockReturnValue([]),
  saveMessageToDatabase: vi.fn(),
  sanitizeMessagesForModel: vi.fn().mockReturnValue([]),
  convertDbMessageToUIMessage: vi.fn(),
  processMentionsInMessage: vi.fn().mockReturnValue({ mentions: [], pageIds: [] }),
  buildMentionSystemPrompt: vi.fn().mockReturnValue(''),
  buildTimestampSystemPrompt: vi.fn().mockReturnValue(''),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
  buildPersonalizationPrompt: vi.fn().mockReturnValue(''),
  filterToolsForReadOnly: vi.fn().mockReturnValue({}),
  filterToolsForWebSearch: vi.fn().mockReturnValue({}),
  getPageTreeContext: vi.fn(),
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn((t: unknown) => t),
  getUserPersonalization: vi.fn().mockResolvedValue(null),
}));

vi.mock('ai', () => ({
  streamText: vi.fn().mockImplementation((options: MockStreamTextOptions) => {
    captured.streamTextOptions = options;
    return {
      toUIMessageStream: () => (async function* () {})(),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({ trackFeature: vi.fn() }));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
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
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  getPageSpaceModelTier: vi.fn().mockReturnValue('standard'),
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

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Fixtures
// ============================================================================

const mockDbRow = {
  id: 'page-1',
  title: 'Test Page',
  systemPrompt: null,
  enabledTools: null,
  aiProvider: 'pagespace',
  aiModel: 'glm-4.5-air',
  driveId: 'drive-1',
  includeDrivePrompt: false,
  includePageTree: false,
  pageTreeScope: null,
  revision: 0,
  name: 'Test User',
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
  subscriptionTier: 'free',
  timezone: 'UTC',
  displayName: 'Test User',
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

const makeRequest = () =>
  new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200' },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      chatId: 'page-1',
      conversationId: 'conv-1',
      selectedProvider: 'pagespace',
      selectedModel: 'glm-4.5-air',
    }),
  });

const mockResponseMessage = {
  id: 'test-message-id',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Hello' }],
};

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/ai/chat — stream socket events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  describe('registry registration', () => {
    it('given a new AI stream, should register the messageId in the multicast registry before streaming', async () => {
      await POST(makeRequest());

      expect(mockRegistryRegister).toHaveBeenCalledWith(
        'test-message-id',
        { pageId: 'page-1', userId: 'user-1' }
      );
    });

    it('given registry.register throws, should not interrupt the stream', async () => {
      mockRegistryRegister.mockImplementationOnce(() => { throw new Error('registry error'); });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
    });
  });

  describe('chat:stream_start broadcast', () => {
    it('given a new AI stream, should broadcast chat:stream_start after registering', async () => {
      await POST(makeRequest());

      expect(mockBroadcastAiStreamStart).toHaveBeenCalled();

      const callOrder = [
        mockRegistryRegister.mock.invocationCallOrder[0],
        mockBroadcastAiStreamStart.mock.invocationCallOrder[0],
      ];
      expect(callOrder[0]).toBeLessThan(callOrder[1]);
    });

    it('given chat:stream_start, should include messageId, pageId, conversationId, and triggeredBy', async () => {
      await POST(makeRequest());

      expect(mockBroadcastAiStreamStart).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'test-message-id',
          pageId: 'page-1',
          conversationId: 'conv-1',
          triggeredBy: expect.objectContaining({
            userId: 'user-1',
            displayName: expect.any(String),
          }),
        })
      );
    });

    it('given a user profile, should use displayName from userProfiles in triggeredBy', async () => {
      await POST(makeRequest());

      const payload = mockBroadcastAiStreamStart.mock.calls[0][0];
      expect(payload.triggeredBy.displayName).toBe('Test User');
    });

    it('given broadcastAiStreamStart throws, should not interrupt the stream', async () => {
      mockBroadcastAiStreamStart.mockRejectedValueOnce(new Error('broadcast error'));

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
    });
  });

  describe('text-delta chunk → registry push', () => {
    it('given a text-delta chunk, should push the text to the registry', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'text-delta', text: 'hello', id: 'chunk-1' } });

      expect(mockRegistryPush).toHaveBeenCalledWith('test-message-id', 'hello');
    });

    it('given a non-text-delta chunk type, should not push to the registry', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', args: {} } });

      expect(mockRegistryPush).not.toHaveBeenCalled();
    });

    it('given registry.push throws on a chunk, should not interrupt the stream', async () => {
      mockRegistryPush.mockImplementationOnce(() => { throw new Error('push error'); });

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      expect(() => {
        captured.streamTextOptions.onChunk?.({ chunk: { type: 'text-delta', text: 'hello', id: 'chunk-1' } });
      }).not.toThrow();
    });
  });

  describe('onFinish → finish + chat:stream_complete', () => {
    it('given stream completion, should call finish with aborted=false', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockRegistryFinish).toHaveBeenCalledWith('test-message-id', false);
    });

    it('given stream completion, should broadcast chat:stream_complete with aborted=false', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'test-message-id',
          pageId: 'page-1',
          aborted: false,
        })
      );
    });

    it('given onFinish called twice, should broadcast chat:stream_complete only once', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAbort → early finish', () => {
    it('given stream abort, should call registry finish with aborted=true', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();

      expect(mockRegistryFinish).toHaveBeenCalledWith('test-message-id', true);
    });

    it('given stream abort, should broadcast chat:stream_complete with aborted=true', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();

      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'test-message-id',
          pageId: 'page-1',
          aborted: true,
        })
      );
    });

    it('given stream abort followed by onFinish, should broadcast complete only once with aborted=true', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledTimes(1);
      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledWith(
        expect.objectContaining({ aborted: true })
      );
    });
  });

  describe('error finally path', () => {
    it('given createUIMessageStream throws, should call finish with aborted=true', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      expect(mockRegistryFinish).toHaveBeenCalledWith('test-message-id', true);
    });

    it('given createUIMessageStream throws, should broadcast chat:stream_complete with aborted=true', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      expect(mockBroadcastAiStreamComplete).toHaveBeenCalledWith(
        expect.objectContaining({ aborted: true })
      );
    });
  });
});
