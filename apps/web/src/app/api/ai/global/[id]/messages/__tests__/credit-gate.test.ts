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
  steps: [] as unknown,
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
  broadcastGlobalConversationAdded: vi.fn().mockResolvedValue(undefined),
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
  eq: vi.fn(), ne: vi.fn(), and: vi.fn(), desc: vi.fn(), gt: vi.fn(), lt: vi.fn(),
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

// The credit gate under test. Default: allowed. Individual tests override.
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
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { streamText } from 'ai';
import { resolveOrCreateConversation, ConversationOwnershipError } from '../resolve-or-create-conversation';

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
      selectedProvider: 'openai',
      selectedModel: 'openai/gpt-5.3-chat',
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
    mockCreateStreamLifecycle.mockResolvedValue({ pushPart: mockLifecyclePushPart, finish: mockLifecycleFinish, getBufferedParts: vi.fn().mockReturnValue([]) });
  });

  it('returns 402 out_of_credits and never starts the stream when the gate denies', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toBe('out_of_credits');
    expect(streamText).not.toHaveBeenCalled();
    expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
  });

  it('does NOT persist the user message when the gate denies (gate runs before save)', async () => {
    // R3: the gate must precede the message save. Otherwise an out-of-credits prompt is
    // written to the conversation and then 402s, leaving an orphaned message that
    // duplicates on retry once the user tops up.
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(402);
    expect(mockSaveGlobalAssistantMessageToDatabase).not.toHaveBeenCalled();
  });

  it('does not block with a 402 when the gate allows', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'ok' });

    const response = await POST(makeRequest(), makeContext());

    expect(canConsumeAI).toHaveBeenCalled();
    expect(response.status).not.toBe(402);
  });

  it('returns 404 when resolveOrCreateConversation throws ConversationOwnershipError and does not start stream', async () => {
    vi.mocked(resolveOrCreateConversation).mockRejectedValueOnce(new ConversationOwnershipError());

    const response = await POST(makeRequest(), makeContext());

    expect(response.status).toBe(404);
    expect(streamText).not.toHaveBeenCalled();
    expect(mockCreateStreamLifecycle).not.toHaveBeenCalled();
  });

});

describe('POST /api/ai/global/[id]/messages — usage logging durability (R4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.createUIMessageStreamOptions = {};
    captured.streamTextOptions = {};
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
    mockCreateStreamLifecycle.mockResolvedValue({ pushPart: mockLifecyclePushPart, finish: mockLifecycleFinish, getBufferedParts: vi.fn().mockReturnValue([]) });
  });

  it('calls AIMonitoring.trackUsage even when the provider returns no usage metadata', async () => {
    // Provider returns no usage — the orphan-sweep depends on a row still being written.
    captured.totalUsage = undefined;

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect(call.model).toBe('openai/gpt-5.3-chat');
    expect(call.totalTokens).toBeUndefined();
  });

  it('still logs the resolved model with token counts when usage is present', async () => {
    captured.totalUsage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect({ model: call.model, totalTokens: call.totalTokens }).toEqual({ model: 'openai/gpt-5.3-chat', totalTokens: 20 });
  });

  it('AWAITS trackUsage in onFinish (durable persistence, not fire-and-forget)', async () => {
    captured.totalUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

    // trackUsage returns a promise that NEVER resolves on its own. If onFinish
    // awaits it (the durability guarantee), onFinish cannot settle no matter how
    // many microtasks flush; a fire-and-forget call would let onFinish settle
    // within a bounded number of flushes. This is what makes the guarantee testable
    // — a synchronous mock + "was it called" assertion would pass either way.
    let resolveTrack!: () => void;
    vi.mocked(AIMonitoring.trackUsage).mockReturnValueOnce(new Promise<void>((res) => { resolveTrack = res; }));

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });

    let settled = false;
    const onFinishPromise = Promise.resolve(
      captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage }),
    ).then(() => { settled = true; });

    for (let i = 0; i < 10; i++) await Promise.resolve(); // flush microtasks
    expect(settled).toBe(false); // onFinish is still awaiting the pending trackUsage

    resolveTrack();
    await onFinishPromise;
    expect(settled).toBe(true);
    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
  });

  it('settles the hold (trackUsage) even when no responseMessage is produced', async () => {
    // Exhausted/no-content run: the retry shell gave up without a message. Settlement
    // must still run — it's the only thing that releases the gate's hold. Skipping it
    // here (the old `if (responseMessage)` gate) silently leaked the hold.
    // (saveGlobalAssistantMessageToDatabase also persists the user message during POST,
    // so we assert the *assistant* save is skipped by comparing counts across onFinish.)
    captured.totalUsage = { inputTokens: 3, outputTokens: 0, totalTokens: 3 };

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    const savesBeforeFinish = mockSaveGlobalAssistantMessageToDatabase.mock.calls.length;
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: undefined });

    // No assistant-message save (nothing to persist), but the hold is still settled.
    expect(mockSaveGlobalAssistantMessageToDatabase.mock.calls.length).toBe(savesBeforeFinish);
    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect(call.model).toBe('openai/gpt-5.3-chat');
  });

  it('settles the hold (trackUsage) even when persisting the assistant message throws', async () => {
    // A save failure must not skip settlement — otherwise a transient DB error leaks the
    // hold. Settlement lives outside the save try/catch, so it runs regardless.
    // Arm the rejection AFTER the user-message save in POST so only the assistant save
    // (in onFinish) throws.
    captured.totalUsage = { inputTokens: 4, outputTokens: 6, totalTokens: 10 };

    await POST(makeRequest(), makeContext());
    await captured.createUIMessageStreamOptions.execute?.({ write: vi.fn() });
    mockSaveGlobalAssistantMessageToDatabase.mockRejectedValueOnce(new Error('db down'));
    await captured.createUIMessageStreamOptions.onFinish?.({ responseMessage: mockResponseMessage });

    expect(AIMonitoring.trackUsage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0];
    expect(call.totalTokens).toBe(10);
  });
});
