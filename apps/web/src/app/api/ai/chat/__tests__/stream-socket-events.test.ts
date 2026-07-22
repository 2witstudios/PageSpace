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
  mockHasConflictingMessageOwner,
  mockTakeOverConversationStreams,
  mockCreateConversation,
} = vi.hoisted(() => ({
  mockCreateStreamLifecycle: vi.fn(),
  mockLifecyclePushPart: vi.fn(),
  mockLifecycleFinish: vi.fn(),
  mockBroadcastChatUserMessage: vi.fn().mockResolvedValue(undefined),
  mockSaveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  mockGetConversation: vi.fn().mockResolvedValue(null), // default: legacy (no row) → broadcast
  mockHasConflictingMessageOwner: vi.fn().mockResolvedValue(false),
  mockTakeOverConversationStreams: vi.fn().mockResolvedValue({ aborted: [], reconciled: [] }),
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

vi.mock('@/lib/ai/core/stream-takeover', () => ({
  takeOverConversationStreams: mockTakeOverConversationStreams,
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
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
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
  logPerformance: vi.fn(),
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
    // Server Stream Durability epic PR 2: assistant placeholder row insert at stream start.
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  // startGenerationExclusive's advisory lock: always free, so takeover+lifecycle-create run
  // exactly as before. Its own retry/degrade behavior is covered by
  // start-generation-exclusive.test.ts — this file only verifies this route wires it in.
  getAdvisoryLockPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
      release: vi.fn(),
    })),
  })),
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), ne: vi.fn(), and: vi.fn() }));
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
  filterToolsForMcpScope: vi.fn().mockReturnValue({}),
  filterToolsForMachineBinding: vi.fn().mockReturnValue({}),
  withSessionFamilyTools: vi.fn((tools: unknown) => tools),
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

vi.mock('@paralleldrive/cuid2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@paralleldrive/cuid2')>()),
  createId: vi.fn().mockReturnValue('test-message-id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-3)}`),
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: mockGetConversation,
    hasConflictingMessageOwner: mockHasConflictingMessageOwner,
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
  attachStreamFinisher: vi.fn(),
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
  DEFAULT_IMAGE_MODEL: 'google/gemini-3.1-flash-image-preview',
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
import { createStreamAbortController } from '@/lib/ai/core/stream-abort-registry';

/** A signal that reports aborted=true — simulates onAbort having already fired. */
const abortedSignal = (): AbortSignal => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
};

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

// A real cuid: POST /api/ai/chat only ever CREATES a conversation from a cuid.
const CONV_ID = 'clhjx7xu5e4yhlvpfs3h7xea';

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
      conversationId: overrides.conversationId ?? CONV_ID,
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
    // clearAllMocks() clears CALLS, not IMPLEMENTATIONS. Seven tests below use mockResolvedValue
    // (not ...Once), so without these two lines each one leaked its fixture into every later test
    // — including the lifecycle-invocation test, which was silently running against an
    // already-owned conversation instead of the intended "no row" default. It passed either way,
    // which is exactly why nobody noticed.
    mockGetConversation.mockResolvedValue(null);
    mockHasConflictingMessageOwner.mockResolvedValue(false);
    mockTakeOverConversationStreams.mockResolvedValue({ aborted: [], reconciled: [] });
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

  // AC3 step 3. The client used to send a `${pageId}-default` sentinel for a brand-new
  // chat and this route accepted it unvalidated, minting a real conversations row under
  // that id — which the client then refused to load back, stranding the history.
  describe('conversationId validation', () => {
    it('given a non-cuid conversationId with no existing row, should 400 rather than create a conversation from it', async () => {
      mockGetConversation.mockResolvedValueOnce(null);

      const response = await POST(makeRequest({ conversationId: 'page-1-default' }));

      expect(response.status).toBe(400);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    // The migration-free recovery path: those sentinel rows EXIST in production, the
    // client now loads them, and it will keep POSTing that id. A bare isCuid reject
    // would lock those users out of the conversation we just gave them back.
    it('given a legacy non-cuid conversationId that DOES exist, should accept it and stream normally', async () => {
      mockGetConversation.mockResolvedValue({ id: 'page-1-default', userId: 'user-1', isShared: false, contextId: 'page-1' });

      const response = await POST(makeRequest({ conversationId: 'page-1-default' }));

      expect(response.status).not.toBe(400);
      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'page-1-default' }),
      );
    });

    it('given a cuid conversationId with no existing row, should allow it (a cuid may always create)', async () => {
      mockGetConversation.mockResolvedValue(null);

      await POST(makeRequest({ conversationId: CONV_ID }));

      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: CONV_ID }),
      );
    });
  });

  // The history load is keyed on (pageId, conversationId) with NO user filter, so an id
  // that resolves to someone else's conversation reads their private history into the
  // model context and appends this user's message to it. `${pageId}-default` is derived
  // from the page id, so it is *guessable* by any member with edit access — this guard
  // is what stops that.
  describe('conversationId authorization', () => {
    it('given an existing conversation owned by ANOTHER user and not shared, should 403', async () => {
      mockGetConversation.mockResolvedValue({
        id: 'page-1-default', userId: 'someone-else', isShared: false, contextId: 'page-1',
      });

      const response = await POST(makeRequest({ conversationId: 'page-1-default' }));

      expect(response.status).toBe(403);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    it('given an existing conversation owned by another user but explicitly SHARED, should allow it AND propagate isShared', async () => {
      mockGetConversation.mockResolvedValue({
        id: CONV_ID, userId: 'someone-else', isShared: true, contextId: 'page-1',
      });

      const response = await POST(makeRequest({ conversationId: CONV_ID }));

      expect(response.status).not.toBe(403);
      // NOT just `toHaveBeenCalled()`. `isShared` rides the chat:stream_start broadcast, and
      // useChannelStreamSocket DROPS a co-member's stream when it is false — so this flag is the
      // sole signal that makes a shared conversation visible to anyone but its owner. Asserting
      // only that the lifecycle was called let a hardcoded `false` pass every test in the suite
      // while every shared conversation went dark for every co-member.
      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: CONV_ID, isShared: true }),
      );
    });

    it('given an existing conversation belonging to a DIFFERENT page, should 403', async () => {
      mockGetConversation.mockResolvedValue({
        id: CONV_ID, userId: 'user-1', isShared: false, contextId: 'some-other-page',
      });

      const response = await POST(makeRequest({ conversationId: CONV_ID }));

      expect(response.status).toBe(403);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    // Fail closed on the LEGACY shape too: a conversation whose messages predate the
    // conversations table has messages under its id and NO row, so an existence-only
    // check would skip the ownership guard entirely — letting a caller read another
    // user's history into their model context, append to it, and (since takeover aborts
    // as the stream's owner) abort its stream.
    it('given a cuid with no conversations row but messages owned by ANOTHER user (legacy), should 403', async () => {
      mockGetConversation.mockResolvedValue(null);
      mockHasConflictingMessageOwner.mockResolvedValueOnce(true);

      const response = await POST(makeRequest({ conversationId: CONV_ID }));

      expect(response.status).toBe(403);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
    });

    // contextId is nullable in the schema (null for global conversations). An owner must
    // never be locked out of their own row by a historically-unset column.
    it('given the caller OWNS a conversation whose contextId is null, should allow it', async () => {
      mockGetConversation.mockResolvedValue({
        id: CONV_ID, userId: 'user-1', isShared: false, contextId: null,
      });

      const response = await POST(makeRequest({ conversationId: CONV_ID }));

      expect(response.status).not.toBe(403);
      expect(mockCreateStreamLifecycle).toHaveBeenCalled();
    });
  });

  // AC5 — takeover, never 409. This route called takeOverConversationStreams and NOTHING asserted
  // it: the module was not even mocked, so the real function ran against a db mock with no
  // .update(), threw, and was swallowed by its own catch. The call site could have been deleted
  // and every test would still have passed.
  describe('per-conversation takeover (AC5)', () => {
    it('takes over the conversation before starting a new generation', async () => {
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(mockTakeOverConversationStreams).toHaveBeenCalledWith({
        conversationId: CONV_ID,
        channelId: 'page-1',
      });
    });

    it('takes over BEFORE creating the new lifecycle — the other order would abort the stream it just started', async () => {
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      const takeoverAt = mockTakeOverConversationStreams.mock.invocationCallOrder[0];
      const lifecycleAt = mockCreateStreamLifecycle.mock.invocationCallOrder[0];
      expect(takeoverAt).toBeLessThan(lifecycleAt);
    });

    // Never 409. A rejection would SELF-LOCK the conversation: the terminal status write is
    // fire-and-forget and dies with its process, so a crashed generation leaves a permanently
    // 'streaming' row. The user would be locked out of their own chat.
    it('given a stream was already in flight, still proceeds — takeover, not rejection', async () => {
      mockTakeOverConversationStreams.mockResolvedValue({
        aborted: ['msg-previous'],
        reconciled: ['msg-previous'],
      });

      const response = await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(response.status).not.toBe(409);
      expect(mockCreateStreamLifecycle).toHaveBeenCalledTimes(1);
    });
  });

  describe('createStreamLifecycle invocation', () => {
    it('given a new AI stream, should construct the lifecycle with channel, conversation, user, displayName, and browserSessionId', async () => {
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(mockCreateStreamLifecycle).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamLifecycle).toHaveBeenCalledWith({
        messageId: 'test-message-id',
        channelId: 'page-1',
        conversationId: CONV_ID,
        userId: 'user-1',
        displayName: 'Profile User',
        browserSessionId: 'session-7',
        // Persisted on the row so an abort landing on ANY instance can resolve the streamId it was
        // handed in X-Stream-Id back to a stream. The registry that mints it is in-process.
        streamId: 'stream_123',
        isShared: false,
      });
    });
  });

  describe('user-message broadcast', () => {
    it('given a POST with a user message, should broadcast chat:user_message after the DB save resolves with the saved message and full envelope', async () => {
      mockGetConversation.mockResolvedValueOnce({ id: CONV_ID, userId: 'user-1', isShared: true });
      await POST(makeRequest({ browserSessionId: 'session-7' }));

      expect(mockBroadcastChatUserMessage).toHaveBeenCalledTimes(1);
      expect(mockBroadcastChatUserMessage).toHaveBeenCalledWith({
        message: { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        pageId: 'page-1',
        conversationId: CONV_ID,
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

      await POST(makeRequest({ conversationId: CONV_ID }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should broadcast when conversation isShared is true', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'other-user', isShared: true,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));

      expect(mockBroadcastChatUserMessage).toHaveBeenCalledTimes(1);
    });

    it('should suppress broadcast when user owns a private conversation', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: false,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should suppress broadcast when private conversation is owned by someone else', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'other-user', isShared: false,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));

      expect(mockBroadcastChatUserMessage).not.toHaveBeenCalled();
    });

    it('should omit mentionNotify from saveMessageToDatabase when isShared=false', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: false,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]?.mentionNotify).toBeUndefined();
    });

    it('should include mentionNotify in saveMessageToDatabase when isShared=true', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: true,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]?.mentionNotify).toBeDefined();
    });
  });

  // PR #2097, Codex P2 finding: the route has THREE writes that can flip the assistant
  // placeholder out of 'streaming' (execute-end, onFinish, and the outer-catch cleanup), but
  // only onFinish carried mentionNotify. execute-end's own docblock says "when onFinish never
  // runs, this write stands as the sole record" — in that documented gap the @mention
  // notification was permanently lost, and materialize-interrupted-stream's CAS-gated notify
  // (which assumes "the route flipped it ⇒ the route notified") could never recover it.
  // Contract: whichever terminal write lands FIRST carries the mention gate, exactly once per
  // request.
  describe('mention notification exactly-once across terminal writes', () => {
    const sharedConversation = () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: true,
      });
    };

    const assistantSaves = () =>
      mockSaveMessageToDatabase.mock.calls.filter((c: { role?: string }[]) => c[0]?.role === 'assistant');

    it('given onFinish never runs (its documented failure mode), the execute-end save carries mentionNotify', async () => {
      sharedConversation();

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saves = assistantSaves();
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[0][0].mentionNotify).toEqual({
        driveId: 'drive-1',
        triggeredByUserId: 'user-1',
        mentionerName: 'Test Page',
      });
    });

    it('given both execute-end and onFinish run, exactly ONE assistant save carries mentionNotify', async () => {
      sharedConversation();

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const withNotify = assistantSaves().filter((c) => c[0]?.mentionNotify !== undefined);
      expect(withNotify).toHaveLength(1);
    });

    it('given the execute-end save rejects, the onFinish save still carries mentionNotify (the flag only latches on success)', async () => {
      sharedConversation();
      let failedOnce = false;
      mockSaveMessageToDatabase.mockImplementation(async (args: { role?: string }) => {
        if (args.role === 'assistant' && !failedOnce) {
          failedOnce = true;
          throw new Error('execute-end persist down');
        }
      });

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saves = assistantSaves();
      expect(saves).toHaveLength(2);
      expect(saves[1][0].mentionNotify).toBeDefined();
    });

    it('given a private conversation, NO terminal write carries mentionNotify', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: false,
      });

      await POST(makeRequest({ conversationId: CONV_ID }));
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const withNotify = assistantSaves().filter((c) => c[0]?.mentionNotify !== undefined);
      expect(withNotify).toHaveLength(0);
    });

    it('given the outer-catch cleanup is the only terminal write (createUIMessageStream threw), it carries mentionNotify', async () => {
      sharedConversation();
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest({ conversationId: CONV_ID }));

      const saves = assistantSaves();
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[0][0]).toMatchObject({ status: 'interrupted' });
      expect(saves[0][0].mentionNotify).toEqual({
        driveId: 'drive-1',
        triggeredByUserId: 'user-1',
        mentionerName: 'Test Page',
      });
    });

    it('given the outer-catch cleanup fires for a private conversation, it does NOT carry mentionNotify', async () => {
      mockGetConversation.mockResolvedValueOnce({
        id: CONV_ID, userId: 'user-1', isShared: false,
      });
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest({ conversationId: CONV_ID }));

      const saves = assistantSaves();
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[0][0].mentionNotify).toBeUndefined();
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
        conversationId: CONV_ID,
        userId: null,
        role: 'assistant',
      });
    });

    // CodeRabbit review: this used to be a "should NOT persist" test — but skipping the
    // execute-end write whenever bufferedParts is empty and the run wasn't aborted left an
    // exhausted-with-no-content run (a sustained provider outage, say) stuck at 'streaming'
    // forever, since onFinish's own `if (responseMessage)` guard also skips it. execute-end
    // now always terminalizes the row.
    it('given buffered parts are empty and the run was not aborted, should still persist as complete (not leave the row stuck at streaming)', async () => {
      // beforeEach already mocks getBufferedParts to return [] — no override needed
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'complete', messageId: 'test-message-id' });
    });

    // Server Stream Durability epic PR 2 — Codex review: a run the user stopped must persist as
    // 'interrupted', not 'complete' (its content, even if non-empty, was cut short). And the
    // write must happen even with ZERO buffered parts when aborted — otherwise a stream stopped
    // before any token arrives leaves its placeholder stuck at 'streaming' forever.
    it('given the run was aborted with buffered content, should persist with status interrupted', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'partial reply' }]),
      });

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted' });
    });

    it('given the run was aborted with ZERO buffered parts, should still persist an interrupted placeholder', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });
      // beforeEach already mocks getBufferedParts to return []

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeDefined();
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted', messageId: 'test-message-id' });
    });

    it('given a normal (non-aborted) run with buffered content, should persist with status complete', async () => {
      mockCreateStreamLifecycle.mockResolvedValueOnce({
        pushPart: mockLifecyclePushPart,
        finish: mockLifecycleFinish,
        getBufferedParts: vi.fn().mockReturnValue([{ type: 'text', text: 'server reply' }]),
      });

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'complete' });
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

    // Server Stream Durability epic PR 2 — Codex review: onFinish's OWN persist (the "refine
    // with the richer SDK responseMessage" write) must also respect abort state — otherwise it
    // would clobber the execute-end block's correct 'interrupted' status back to 'complete'.
    it('given the run was aborted, onFinish should persist with status interrupted even with a responseMessage', async () => {
      vi.mocked(createStreamAbortController).mockReturnValueOnce({ streamId: 'stream_123', signal: abortedSignal(), controller: new AbortController() });

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted' });
    });

    it('given a normal (non-aborted) run, onFinish should persist with status complete', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'complete' });
    });

    it('given createUIMessageStream throws, should call lifecycle.finish(true)', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      expect(mockLifecycleFinish).toHaveBeenCalledWith(true);
    });

    // Server Stream Durability epic PR 2 — Codex review, extended: if createUIMessageStream
    // itself throws, neither execute-end nor onFinish ever ran — without a last-resort write
    // here, the placeholder inserted before this point would be stuck at 'streaming' forever.
    it('given createUIMessageStream throws, should terminalize the placeholder as interrupted', async () => {
      const { createUIMessageStream } = await import('ai');
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted', messageId: 'test-message-id' });
    });

    // Regression guard: getBufferedParts() MUST be read before lifecycle.finish() is called —
    // finish() deletes the multicast registry entry backing it, so reading it afterward always
    // sees an empty buffer. This mock reproduces that real ordering dependency (getBufferedParts
    // returns [] once mockLifecycleFinish has been called), so a regression that swaps the two
    // calls back would silently drop real partial content and this test would catch it.
    it('given createUIMessageStream throws with real buffered content, should preserve that content (not lose it to finish() clearing the buffer)', async () => {
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
        throw new Error('stream creation failed');
      });

      await POST(makeRequest());

      const saveCalls = mockSaveMessageToDatabase.mock.calls;
      const assistantSave = saveCalls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      // extractMessageContent is fixture-mocked (always 'test content'), so assert on the
      // synthesized uiMessage's parts instead — synthesizeAssistantMessage is NOT mocked and
      // reflects exactly what buildAssistantPersistencePayload was called with.
      expect(assistantSave?.[0]).toMatchObject({ status: 'interrupted' });
      expect((assistantSave?.[0] as { uiMessage?: { parts?: unknown[] } })?.uiMessage?.parts).toEqual(bufferedParts);
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

      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: { id: 'test-message-id', role: 'assistant', parts: [] } });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: { id: 'test-message-id', role: 'assistant', parts: [] } });

      const assistantSave = mockSaveMessageToDatabase.mock.calls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
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

      await POST(makeRequest());

      expect(mockTakeOverConversationStreams).toHaveBeenCalledTimes(1);
      expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
      const assistantSave = mockSaveMessageToDatabase.mock.calls.find((c: { role?: string }[]) => c[0]?.role === 'assistant');
      expect(assistantSave).toBeUndefined();
    });
  });
});
