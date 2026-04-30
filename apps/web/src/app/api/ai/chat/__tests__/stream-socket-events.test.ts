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
  mockLifecyclePushChunk,
  mockLifecycleFinish,
} = vi.hoisted(() => ({
  mockCreateStreamLifecycle: vi.fn(),
  mockLifecyclePushChunk: vi.fn(),
  mockLifecycleFinish: vi.fn(),
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
  broadcastUsageEvent: vi.fn(),
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

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { MAX_BROWSER_SESSION_ID_LENGTH } from '@/lib/ai/core/browser-session-id-validation';

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
  name: 'Auth User',
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
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

const makeRequest = (overrides: { browserSessionId?: string | null } = {}) => {
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
      conversationId: 'conv-1',
      selectedProvider: 'pagespace',
      selectedModel: 'glm-4.5-air',
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
      pushChunk: mockLifecyclePushChunk,
      finish: mockLifecycleFinish,
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

  describe('chunk forwarding', () => {
    it('given a text-delta chunk, should forward the text to lifecycle.pushChunk', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'text-delta', text: 'hello', id: 'c1' } });

      expect(mockLifecyclePushChunk).toHaveBeenCalledWith('hello');
    });

    it('given a non-text-delta chunk, should not forward anything', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'tool-call', toolCallId: 'tc', toolName: 'x', args: {} } });

      expect(mockLifecyclePushChunk).not.toHaveBeenCalled();
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
