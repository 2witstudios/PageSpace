/**
 * Verifies that the global chat POST handler delegates streaming lifecycle
 * (registry, DB persistence, socket broadcasts) to createStreamLifecycle and
 * routes chunk/finish/abort events through the returned handle.
 *
 * Lifecycle internals are tested in stream-lifecycle.test.ts.
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
const mockAuthUser = { name: 'Auth User' };

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
          ) => Promise.resolve([mockConversation]).then(resolve, reject),
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue(isUsers ? [mockAuthUser] : [mockUserProfile]),
        })),
      };
    }),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  return {
    db: { select, insert, update },
  };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { __label: 'users', id: 'id', name: 'name' },
}));

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

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'glm-4.5-air' }),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn().mockReturnValue(false),
  pageSpaceTools: {},
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
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
}));

vi.mock('@pagespace/lib/monitoring/ai-context-calculator', () => ({
  calculateTotalContextSize: vi.fn().mockReturnValue({
    totalTokens: 0,
    messageCount: 0,
    systemPromptTokens: 0,
    toolDefinitionTokens: 0,
    conversationTokens: 0,
    wasTruncated: false,
    truncationStrategy: undefined,
    messageIds: [],
  }),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({ isMember: false, role: null }),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn().mockReturnValue(50),
}));

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

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { MAX_BROWSER_SESSION_ID_LENGTH } from '@/lib/ai/core/browser-session-id-validation';

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
  return new Request('https://example.com/api/ai/global/conv-1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      selectedProvider: 'pagespace',
      selectedModel: 'glm-4.5-air',
    }),
  });
};

const makeContext = () => ({ params: Promise.resolve({ id: 'conv-1' }) });

const mockResponseMessage = {
  id: 'test-message-id',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Hello' }],
};

describe('POST /api/ai/global/[id]/messages — lifecycle handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    mockCreateStreamLifecycle.mockResolvedValue({
      pushPart: mockLifecyclePushPart,
      finish: mockLifecycleFinish,
    });
  });

  describe('X-Browser-Session-Id contract', () => {
    it('given a missing X-Browser-Session-Id header, should return 400 before invoking the lifecycle', async () => {
      const response = await POST(makeRequest({ browserSessionId: null }), makeContext());

      expect(response.status).toBe(400);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    it('given an X-Browser-Session-Id header longer than the cap, should return 400 before invoking the lifecycle', async () => {
      const oversized = 'a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH + 1);
      const response = await POST(makeRequest({ browserSessionId: oversized }), makeContext());

      expect(response.status).toBe(400);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    it('given an X-Browser-Session-Id header at exactly the cap, should accept and invoke the lifecycle', async () => {
      const maxLength = 'a'.repeat(MAX_BROWSER_SESSION_ID_LENGTH);
      await POST(makeRequest({ browserSessionId: maxLength }), makeContext());

      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ browserSessionId: maxLength }),
      );
    });
  });

  describe('createStreamLifecycle invocation', () => {
    it('given a new global stream, should construct the lifecycle with channelId user:${userId}:global and the request browserSessionId', async () => {
      await POST(makeRequest({ browserSessionId: 'session-y' }), makeContext());

      expect(mockCreateStreamLifecycle).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith({
        messageId: 'test-message-id',
        channelId: 'user:user-1:global',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Display User',
        browserSessionId: 'session-y',
      });
    });

    it('given userProfiles displayName is null, should fall back to users.name from the auth-user lookup', async () => {
      const dbModule = await import('@pagespace/db/db');
      const fromImpl = vi.fn((table: unknown) => {
        const tableLabel = table as { __label?: string } | undefined;
        const isUsers = tableLabel?.__label === 'users';
        return {
          where: vi.fn(() => ({
            then: <T>(resolve?: ((value: unknown[]) => T | PromiseLike<T>) | null) =>
              Promise.resolve([mockConversation]).then(resolve),
            orderBy: vi.fn().mockResolvedValue([]),
            limit: vi.fn().mockResolvedValue(isUsers ? [{ name: 'Auth User' }] : [{ displayName: null }]),
          })),
        };
      });
      vi.mocked(dbModule.db.select).mockImplementationOnce(() => ({
        from: fromImpl,
      }) as unknown as ReturnType<typeof dbModule.db.select>);
      // Then for the other selects in the route, use default mock
      vi.mocked(dbModule.db.select).mockImplementation(() => ({
        from: vi.fn((table: unknown) => {
          const tableLabel = table as { __label?: string } | undefined;
          const isUsers = tableLabel?.__label === 'users';
          return {
            where: vi.fn(() => ({
              then: <T>(resolve?: ((value: unknown[]) => T | PromiseLike<T>) | null) =>
                Promise.resolve([mockConversation]).then(resolve),
              orderBy: vi.fn().mockResolvedValue([]),
              limit: vi.fn().mockResolvedValue(
                isUsers ? [{ name: 'Auth User' }] : [{ displayName: null }],
              ),
            })),
          };
        }),
      }) as unknown as ReturnType<typeof dbModule.db.select>);

      await POST(makeRequest(), makeContext());

      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Auth User' }),
      );
    });
  });

  describe('user-message broadcast', () => {
    it('given a POST with a user message, should broadcast chat:user_message routed to the per-user global channel', async () => {
      await POST(makeRequest({ browserSessionId: 'session-y' }), makeContext());

      expect(mockBroadcastChatUserMessage).toHaveBeenCalledTimes(1);
      // displayName resolution is covered by its own test; here we lock the
      // routing fields and the saved-message passthrough.
      expect(mockBroadcastChatUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
          pageId: 'user:user-1:global',
          conversationId: 'conv-1',
          triggeredBy: expect.objectContaining({
            userId: 'user-1',
            browserSessionId: 'session-y',
          }),
        }),
      );
    });

    it('given the user-message DB save rejects, should NOT broadcast chat:user_message', async () => {
      mockSaveGlobalAssistantMessageToDatabase.mockRejectedValueOnce(new Error('db down'));

      await POST(makeRequest(), makeContext());

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('given broadcastChatUserMessage rejects, should not block the request', async () => {
      mockBroadcastChatUserMessage.mockRejectedValueOnce(new Error('socket dead'));

      await expect(POST(makeRequest(), makeContext())).resolves.toBeDefined();
    });
  });

  describe('chunk forwarding', () => {
    it('given a text-delta chunk, should forward a text part to lifecycle.pushPart', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'text-delta', text: 'hello', id: 'c1' } });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({ type: 'text', text: 'hello' });
    });

    it('given a tool-call chunk, should forward an input-available tool part', async () => {
      await POST(makeRequest(), makeContext());
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

    it('given a tool-result chunk, should forward an output-available tool part', async () => {
      await POST(makeRequest(), makeContext());
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

    it('given a chunk type out of v1 multicast scope, should not forward anything', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({ chunk: { type: 'finish-step' } });

      expect(mockLifecyclePushPart).not.toHaveBeenCalled();
    });
  });

  describe('finish forwarding', () => {
    it('given onFinish runs, should call lifecycle.finish(false)', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockLifecycleFinish).toHaveBeenCalledWith(false);
    });

    it('given onAbort fires, should call lifecycle.finish(true)', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();

      expect(mockLifecycleFinish).toHaveBeenCalledWith(true);
    });

    it('given an error throws after lifecycle creation, should call lifecycle.finish(true) from the outer catch', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('post-lifecycle boom');
      });

      await POST(makeRequest(), makeContext());

      const aborted = mockLifecycleFinish.mock.calls.filter(([flag]) => flag === true);
      expect(aborted.length).toBeGreaterThan(0);
    });
  });
});
