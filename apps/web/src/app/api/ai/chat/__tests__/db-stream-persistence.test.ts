/**
 * Tests for Task 4: page AI chat route persists stream lifecycle to aiStreamSessions.
 *
 * Verifies:
 *   - INSERT on stream start (status='streaming')
 *   - UPDATE to status='complete' on successful finish
 *   - UPDATE to status='aborted' on abort
 *   - INSERT uses onConflictDoUpdate so duplicate messageIds do not throw
 *   - DB write failures do not abort the stream
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockInsertValues,
  mockInsertOnConflict,
  mockUpdateSet,
  mockUpdateWhere,
  mockRegistryRegister,
  mockRegistryFinish,
  aiStreamSessionsToken,
} = vi.hoisted(() => ({
  mockInsertValues: vi.fn(),
  mockInsertOnConflict: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockRegistryRegister: vi.fn(),
  mockRegistryFinish: vi.fn(),
  aiStreamSessionsToken: { __table: 'ai_stream_sessions', messageId: 'message_id' },
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

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('@/lib/ai/core/stream-multicast-registry', () => ({
  streamMulticastRegistry: {
    register: mockRegistryRegister,
    push: vi.fn(),
    finish: mockRegistryFinish,
    getMeta: vi.fn(),
    subscribe: vi.fn(),
  },
  StreamMulticastRegistry: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastUsageEvent: vi.fn(),
  broadcastAiStreamStart: vi.fn().mockResolvedValue(undefined),
  broadcastAiStreamComplete: vi.fn().mockResolvedValue(undefined),
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
          limit: vi.fn().mockResolvedValue([{ displayName: 'Sasha Profile', drivePrompt: null }]),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        mockInsertValues(table, row);
        return {
          onConflictDoUpdate: (cfg: Record<string, unknown>) => {
            mockInsertOnConflict(cfg);
            return Promise.resolve();
          },
          onConflictDoNothing: () => {
            mockInsertOnConflict({ kind: 'doNothing' });
            return Promise.resolve();
          },
          then: <T>(resolve?: ((value: undefined) => T | PromiseLike<T>) | null) =>
            Promise.resolve(undefined).then(resolve),
        };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        mockUpdateSet(table, patch);
        return {
          where: (clause: unknown) => {
            mockUpdateWhere(clause);
            return Promise.resolve();
          },
        };
      },
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((col, val) => ({ col, val })), and: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: { userId: 'userId', displayName: 'displayName' },
}));
vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: aiStreamSessionsToken,
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
  createId: vi.fn().mockReturnValue('msg-task4'),
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
import { db } from '@pagespace/db/db';
import { createUIMessageStream } from 'ai';
import { broadcastAiStreamStart } from '@/lib/websocket';

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
  name: 'Sasha Fallback',
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
  subscriptionTier: 'free',
  timezone: 'UTC',
  displayName: 'Sasha Profile',
  drivePrompt: null,
};

const mockAuth = (): SessionAuthResult => ({
  userId: 'user-7',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-9',
  role: 'user',
  adminRoleVersion: 0,
});

const makeRequest = (extraHeaders: Record<string, string> = {}) =>
  new Request('https://example.com/api/ai/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '200',
      ...extraHeaders,
    },
    body: JSON.stringify({
      messages: [{ id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      chatId: 'page-1',
      conversationId: 'conv-77',
      selectedProvider: 'pagespace',
      selectedModel: 'glm-4.5-air',
    }),
  });

const mockResponseMessage = {
  id: 'msg-task4',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'Hello' }],
};

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/ai/chat — aiStreamSessions persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  describe('AC1 — INSERT on stream start', () => {
    it('given a new AI stream, should INSERT a row into aiStreamSessions with status=streaming and full identity fields', async () => {
      await POST(makeRequest({ 'X-Tab-Id': 'tab-7' }));

      expect(mockInsertValues).toHaveBeenCalled();
      const [table, row] = mockInsertValues.mock.calls[0];
      expect(table).toBe(aiStreamSessionsToken);
      expect(row).toMatchObject({
        messageId: 'msg-task4',
        channelId: 'page-1',
        conversationId: 'conv-77',
        userId: 'user-7',
        displayName: 'Sasha Profile',
        tabId: 'tab-7',
        status: 'streaming',
      });
    });

    it('given the registry was just populated, should INSERT after registry.register', async () => {
      await POST(makeRequest());

      const registerOrder = mockRegistryRegister.mock.invocationCallOrder[0];
      const insertOrder = mockInsertValues.mock.invocationCallOrder[0];
      expect(registerOrder).toBeLessThan(insertOrder);
    });

    it('given the DB insert rejects, should not interrupt the stream', async () => {
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw new Error('connection refused');
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
    });
  });

  describe('AC2 — UPDATE on stream complete', () => {
    it('given onFinish runs, should UPDATE aiStreamSessions to status=complete with completedAt set', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockUpdateSet).toHaveBeenCalled();
      const [table, patch] = mockUpdateSet.mock.calls[0];
      expect(table).toBe(aiStreamSessionsToken);
      expect(patch.status).toBe('complete');
      expect(patch.completedAt).toBeInstanceOf(Date);
    });

    it('given onFinish runs, should UPDATE the row whose messageId matches the assistant message', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockUpdateWhere).toHaveBeenCalled();
      const [clause] = mockUpdateWhere.mock.calls[0];
      expect(clause).toMatchObject({ val: 'msg-task4' });
    });

    it('given onFinish fires twice, should only UPDATE once (single finishMulticast guard)', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });
      await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC3 — UPDATE on stream abort', () => {
    it('given onAbort fires, should UPDATE aiStreamSessions to status=aborted with completedAt set', async () => {
      await POST(makeRequest());
      await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

      captured.streamTextOptions.onAbort?.();

      expect(mockUpdateSet).toHaveBeenCalled();
      const [, patch] = mockUpdateSet.mock.calls[0];
      expect(patch.status).toBe('aborted');
      expect(patch.completedAt).toBeInstanceOf(Date);
    });

    it('given the route handler errors after register, should UPDATE to status=aborted via the outer-catch finishMulticast', async () => {
      vi.mocked(createUIMessageStream).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      await POST(makeRequest());

      expect(mockUpdateSet).toHaveBeenCalled();
      const [, patch] = mockUpdateSet.mock.calls[0];
      expect(patch.status).toBe('aborted');
    });
  });

  describe('AC4 — duplicate messageId conflict handling', () => {
    it('given a messageId already exists, should call onConflictDoUpdate to refresh status to streaming', async () => {
      await POST(makeRequest());

      expect(mockInsertOnConflict).toHaveBeenCalled();
      const [cfg] = mockInsertOnConflict.mock.calls[0];
      expect(cfg.set).toMatchObject({ status: 'streaming', completedAt: null });
    });
  });

  describe('INSERT-happens-before-broadcast invariant', () => {
    it('given a deferred db.insert, should not broadcast chat:stream_start until the row is committed', async () => {
      let resolveInsert!: () => void;
      const insertSettled = new Promise<void>((resolve) => {
        resolveInsert = resolve;
      });

      vi.mocked(db.insert).mockImplementationOnce(((table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          mockInsertValues(table, row);
          return {
            onConflictDoUpdate: (cfg: Record<string, unknown>) => {
              mockInsertOnConflict(cfg);
              return insertSettled;
            },
          };
        },
      })) as unknown as typeof db.insert);

      const postPromise = POST(makeRequest());

      await vi.waitFor(() => {
        expect(mockInsertValues).toHaveBeenCalled();
      }, { timeout: 1000, interval: 5 });

      expect(broadcastAiStreamStart).not.toHaveBeenCalled();

      resolveInsert();
      await postPromise;

      expect(broadcastAiStreamStart).toHaveBeenCalled();
    });
  });
});
