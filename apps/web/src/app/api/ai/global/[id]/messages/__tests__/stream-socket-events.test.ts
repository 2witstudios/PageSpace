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
  mockBroadcastGlobalConversationAdded,
  mockSaveGlobalAssistantMessageToDatabase,
} = vi.hoisted(() => ({
  mockCreateStreamLifecycle: vi.fn(),
  mockLifecyclePushPart: vi.fn(),
  mockLifecycleFinish: vi.fn(),
  mockBroadcastChatUserMessage: vi.fn().mockResolvedValue(undefined),
  mockBroadcastGlobalConversationAdded: vi.fn().mockResolvedValue(undefined),
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

const { mockTakeOverConversationStreams } = vi.hoisted(() => ({
  mockTakeOverConversationStreams: vi.fn().mockResolvedValue({ aborted: [], reconciled: [] }),
}));

vi.mock('@/lib/ai/core/stream-lifecycle', () => ({
  createStreamLifecycle: mockCreateStreamLifecycle,
}));

vi.mock('@/lib/websocket', () => ({
  broadcastCreditsEvent: vi.fn().mockResolvedValue(undefined),
  broadcastChatUserMessage: mockBroadcastChatUserMessage,
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastGlobalConversationAdded: mockBroadcastGlobalConversationAdded,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
}));

vi.mock('@/lib/ai/core/stream-takeover', () => ({
  takeOverConversationStreams: mockTakeOverConversationStreams,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() })),
    },
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
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]),
      })),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  // startGenerationExclusive's advisory lock: always free, so takeover+lifecycle-create run
  // exactly as before. Its own retry/degrade behavior is covered by
  // start-generation-exclusive.test.ts — this file only verifies this route wires it in.
  const getAdvisoryLockPool = vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
      release: vi.fn(),
    })),
  }));

  return {
    db: { select, insert, update },
    getAdvisoryLockPool,
  };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  exists: vi.fn((sub) => ({ type: 'exists', sub })),
}));

// resolveOrCreateConversation is tested in its own file; here we stub it so
// the route tests don't have to wire up the conversations db mock for it.
vi.mock('../resolve-or-create-conversation', () => ({
  resolveOrCreateConversation: vi.fn().mockResolvedValue({
    conversation: { id: 'conv-1', userId: 'user-1', title: 'Test Conversation', type: 'global', contextId: null, isActive: true, createdAt: new Date('2024-01-01') },
    isNew: false,
  }),
  ConversationOwnershipError: class ConversationOwnershipError extends Error {},
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

vi.mock('@/lib/ai/tools/execute-tool', () => ({
  createExecuteTool: vi.fn().mockReturnValue({}),
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
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn(), trackToolUsage: vi.fn() },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
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
  attachStreamFinisher: vi.fn(),
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

vi.mock('@/lib/ai/tools/finish-tool', () => ({
  finishTool: {},
  FINISH_TOOL_NAME: 'finish',
}));

vi.mock('@/lib/ai/tools/tool-search-tool', () => ({
  createToolSearchTool: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/ai/core/compaction/prepare-context', () => ({
  prepareConversationContext: vi.fn().mockImplementation(
    ({ messages }: { messages: unknown[] }) =>
      Promise.resolve({ messages, scheduleCompaction: () => {}, pendingCompaction: null }),
  ),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';
import { MAX_BROWSER_SESSION_ID_LENGTH } from '@/lib/ai/core/browser-session-id-validation';
import { createStreamAbortController } from '@/lib/ai/core/stream-abort-registry';
import { db } from '@pagespace/db/db';
import { conversations } from '@pagespace/db/schema/conversations';

/** A signal that reports aborted=true — simulates onAbort having already fired. */
const abortedSignal = (): AbortSignal => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
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
  return new Request('https://example.com/api/ai/global/conv-1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
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
      getBufferedParts: vi.fn().mockReturnValue([]),
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

  // AC5 applied to this route too. Without it the global assistant happily starts a
  // SECOND generation on the same conversation — two agents, two assistant rows, two
  // bills — which is exactly what the guard on POST /api/ai/chat prevents. The gap was
  // real: this route calls createStreamLifecycle and had no in-flight guard at all.
  describe('per-conversation takeover guard', () => {
    it('given a new stream, should take over any in-flight stream on this conversation BEFORE creating the lifecycle', async () => {
      await POST(makeRequest(), makeContext());

      expect(mockTakeOverConversationStreams).toHaveBeenCalledTimes(1);
      // Exact values. Both are known constants here, so expect.any(String) would have accepted a
      // route that SWAPPED them — and a takeover keyed on the wrong conversation aborts the wrong
      // streams, or none, while a second generation starts beside the first.
      expect(mockTakeOverConversationStreams).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          channelId: 'user:user-1:global',
        }),
      );
      expect(mockTakeOverConversationStreams.mock.invocationCallOrder[0])
        .toBeLessThan(mockCreateStreamLifecycle.mock.invocationCallOrder[0]);
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
        // Persisted on the row so an abort landing on ANY instance can resolve the streamId it was
        // handed in X-Stream-Id back to a stream. The registry that mints it is in-process.
        streamId: 'stream_123',
        // Rides the stream_start broadcast so page members can tell a stream they may
        // watch from a co-member's PRIVATE conversation, without firing a doomed join.
        isShared: false,
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

  const newConv = {
    id: 'conv-1', userId: 'user-1', title: null, type: 'global',
    contextId: null, isActive: true, isShared: false,
    createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'), lastMessageAt: null,
  };

  describe('global conversation-added broadcast', () => {
    it('given isNew=true, should broadcast chat:global_conversation_added to the user channel', async () => {
      const { resolveOrCreateConversation } = await import('../resolve-or-create-conversation');
      vi.mocked(resolveOrCreateConversation).mockResolvedValueOnce({ conversation: newConv, isNew: true });

      await POST(makeRequest({ browserSessionId: 'session-z' }), makeContext());

      expect(mockBroadcastGlobalConversationAdded).toHaveBeenCalledTimes(1);
      expect(mockBroadcastGlobalConversationAdded).toHaveBeenCalledWith(
        'user:user-1:global',
        expect.objectContaining({
          conversation: expect.objectContaining({ id: 'conv-1', type: 'global' }),
          triggeredBy: expect.objectContaining({ userId: 'user-1', browserSessionId: 'session-z' }),
        }),
      );
    });

    it('given isNew=true and no prior title, broadcast carries the auto-generated title', async () => {
      const { resolveOrCreateConversation } = await import('../resolve-or-create-conversation');
      vi.mocked(resolveOrCreateConversation).mockResolvedValueOnce({ conversation: newConv, isNew: true });

      await POST(makeRequest(), makeContext());

      // extractMessageContent is mocked to return 'test content'; title is sliced from it.
      expect(mockBroadcastGlobalConversationAdded).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          conversation: expect.objectContaining({ title: 'test content' }),
        }),
      );
    });

    it('given isNew=false, should NOT broadcast chat:global_conversation_added', async () => {
      // default resolveOrCreateConversation mock returns isNew: false
      await POST(makeRequest(), makeContext());

      expect(mockBroadcastGlobalConversationAdded).not.toHaveBeenCalled();
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

    it('given a tool-error chunk, should forward an output-error tool part with errorText', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onChunk?.({
        chunk: {
          type: 'tool-error',
          toolCallId: 'tc1',
          toolName: 'list_pages',
          input: { driveId: 'd1' },
          error: new Error('quota exceeded'),
        },
      });

      expect(mockLifecyclePushPart).toHaveBeenCalledWith({
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-error',
        input: { driveId: 'd1' },
        errorText: 'quota exceeded',
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

    // Server Stream Durability epic PR 2 — Codex review: a run the user stopped must persist as
    // 'interrupted', not 'complete'. And the write must happen even with no responseMessage when
    // aborted — otherwise a stream stopped before any token arrives leaves its placeholder stuck
    // at 'streaming' forever (excluded from every reader by default, 409s on edit/delete).
    it('given the run was aborted, onFinish should persist with status interrupted even with a responseMessage', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });

      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted' });
    });

    it('given a normal (non-aborted) run, onFinish should persist with status complete', async () => {
      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'complete' });
    });

    // CodeRabbit review: execute-end (not onFinish) is now the durable, unconditional terminal
    // write — it runs regardless of client disconnect (onFinish is response-stream-coupled and
    // may never fire when a mobile client backgrounds mid-stream, per #2065). onFinish's own
    // no-responseMessage branch does nothing now; execute-end has already terminalized the row
    // by the time onFinish would have run.
    it('given the run was aborted with buffered content, execute-end should persist an interrupted placeholder', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'partial reply' }]),
      });

      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted', messageId: 'test-message-id' });
    });

    // Line-by-line review finding: the terminal write must bump conversations.lastMessageAt —
    // otherwise a conversation-list view sorted by lastMessageAt never surfaces a conversation
    // whose only new activity was an interrupted, no-responseMessage assistant row.
    it('given the run was aborted with buffered content, execute-end should bump conversations.lastMessageAt', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'partial reply' }]),
      });

      await POST(makeRequest(), makeContext());
      const updateCallsBeforeExecute = vi.mocked(db.update).mock.calls.length;
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const newUpdateCalls = vi.mocked(db.update).mock.calls.slice(updateCallsBeforeExecute);
      expect(newUpdateCalls.some((call) => call[0] === conversations)).toBe(true);
    });

    // CodeRabbit review: a run that exhausted its retries without ever aborting or producing a
    // responseMessage (a sustained provider outage, say) used to fall through BOTH onFinish's
    // `if (responseMessage)` guard and (before this PR) any execute-end equivalent, leaving the
    // placeholder stuck at 'streaming' forever. execute-end now always terminalizes the row.
    it('given buffered content and the run was NOT aborted, execute-end should persist as complete (not leave the row stuck at streaming)', async () => {
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([]),
      });

      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'complete', messageId: 'test-message-id' });
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

    // Server Stream Durability epic PR 2 — Codex review, extended: if createUIMessageStream
    // itself throws, onFinish never ran — without a last-resort write here, the placeholder
    // inserted before this point would be stuck at 'streaming' forever.
    it('given an error throws after lifecycle creation, should terminalize the placeholder as interrupted', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('post-lifecycle boom');
      });

      await POST(makeRequest(), makeContext());

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted', messageId: 'test-message-id' });
    });

    // Regression guard: getBufferedParts() MUST be read before lifecycle.finish() is called —
    // finish() deletes the multicast registry entry backing it, so reading it afterward always
    // sees an empty buffer. This mock reproduces that real ordering dependency.
    it('given an error throws after lifecycle creation with real buffered content, should preserve that content', async () => {
      const bufferedParts = [{ type: 'text', text: 'partial reply before the crash' }];
      let finished = false;
      mockLifecycleFinish.mockImplementationOnce(() => { finished = true; });
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn(() => (finished ? [] : bufferedParts)),
      });
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('post-lifecycle boom');
      });

      await POST(makeRequest(), makeContext());

      const saveCalls = mockSaveGlobalAssistantMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted' });
      expect((assistantSave?.[0] as { uiMessage?: { parts?: unknown[] } })?.uiMessage?.parts).toEqual(bufferedParts);
    });

    // Server Stream Durability epic PR 2 — self-review: the AI SDK always calls onFinish with a
    // non-null responseMessage (an empty shell), even when execute() returned immediately without
    // writing anything. For a pre-aborted stream the placeholder INSERT is deliberately skipped —
    // without this guard, onFinish's upsert would INSERT a phantom empty 'interrupted' row for a
    // request that never reached the model.
    it('given the stream was pre-aborted, onFinish should NOT persist a phantom row (no placeholder was ever inserted)', async () => {
      // preAborted's own handling calls abortController.abort() — needs a real controller,
      // unlike the file's bare-signal default (see "given the run was aborted" above).
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([]),
        preAborted: true,
      });

      await POST(makeRequest(), makeContext());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: { id: 'test-message-id', role: 'assistant', parts: [] } });

      const assistantSave = mockSaveGlobalAssistantMessageToDatabase.mock.calls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeUndefined();
    });

    // Server Stream Durability epic PR 2 — self-review: the outer-catch cleanup must not fire
    // when `lifecycle` was never assigned (an exception inside startGenerationExclusive's
    // callback, before the placeholder INSERT ever ran) — otherwise it fabricates a phantom
    // 'interrupted' row for a request that never started generating.
    it('given the pre-generation setup throws before lifecycle is created, should NOT persist a phantom row', async () => {
      // Persistent (not -Once) so this stays a valid regression test regardless: a `run`
      // failure now propagates once and is never retried unlocked (see
      // start-generation-exclusive.ts's guardedRun/runThrew — the double-generation/
      // double-billing fix), so takeOverConversationStreams below is asserted to run exactly
      // once. If that guard ever regresses, a persistent rejection means the retried call
      // would ALSO fail loudly here rather than silently succeeding and masking the bug.
      mockTakeOverConversationStreams.mockRejectedValue(new Error('takeover boom'));

      await POST(makeRequest(), makeContext());

      expect(mockTakeOverConversationStreams).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
      const assistantSave = mockSaveGlobalAssistantMessageToDatabase.mock.calls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeUndefined();
    });
  });
});
