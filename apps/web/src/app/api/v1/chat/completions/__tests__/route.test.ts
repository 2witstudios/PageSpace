import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (must be hoisted before imports) ---

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    query: {
      chatMessages: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn().mockResolvedValue({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    createConversation: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col, val) => ({ __eq: val })),
  and: vi.fn((...args) => ({ __and: args })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', type: 'pages.type' },
  chatMessages: {},
  drives: {},
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { AI_CHAT: 'AI_CHAT', DOCUMENT: 'DOCUMENT' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'openai', modelName: 'openai/gpt-5.3-chat' }),
  isProviderError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r && 'status' in r),
}));
vi.mock('@/lib/ai/core/system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('You are a helpful agent.'),
}));
vi.mock('@/lib/ai/core/message-utils', () => ({
  sanitizeMessagesForModel: vi.fn((msgs: unknown[]) => msgs),
  saveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  convertDbMessageToUIMessage: vi.fn((m: unknown) => {
    const msg = m as { id: string; role: string; content: string };
    return { id: msg.id, role: msg.role as 'user' | 'assistant', parts: [{ type: 'text' as const, text: msg.content || '' }] };
  }),
  extractMessageContent: vi.fn().mockReturnValue('Hello'),
  extractToolResults: vi.fn().mockReturnValue([]),
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {},
}));
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForReadOnly: vi.fn((tools: unknown) => tools),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/ai/tools/tool-exposure', () => ({
  applyToolExposureMode: vi.fn((tools: unknown) => ({ tools, toolDiscoveryPrompt: '' })),
}));

vi.mock('@/lib/ai/tools/finish-tool', () => ({
  finishTool: {},
  FINISH_TOOL_NAME: 'finish',
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('test-id-123'),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesForPage: vi.fn().mockResolvedValue([]),
    getMessagesByConversationId: vi.fn().mockResolvedValue([]),
    updateMessageToolResults: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn().mockResolvedValue(undefined),
  },
  extractOpenRouterCostDollars: vi.fn(() => undefined),
  extractOpenRouterGenerationIds: vi.fn(() => []),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: vi.fn().mockResolvedValue({ allowed: true, reason: 'unlimited' }),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    // The route settles billing after the stream drains, reading aiResult.totalUsage and
    // aiResult.steps, so the mock exposes those promises alongside the chunk stream.
    streamText: vi.fn().mockImplementation(() => ({
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      steps: Promise.resolve([]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 'text-1', delta: 'Hello' };
        yield { type: 'finish' };
      },
    })),
  };
});

// --- imports after mocks ---
import { NextResponse } from 'next/server';
import { streamText } from 'ai';
import { POST } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { sanitizeMessagesForModel, extractMessageContent, saveMessageToDatabase, extractToolResults } from '@/lib/ai/core/message-utils';
import type { UIMessage } from 'ai';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const mcpAuth = {
  userId: 'user-1',
  tokenType: 'mcp' as const,
  tokenId: 'token-1',
  allowedDriveIds: [],
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 0,
};

const agentPage = {
  id: 'page-123',
  type: 'AI_CHAT',
  title: 'Test Agent',
  driveId: 'drive-abc',
  systemPrompt: null,
  aiProvider: 'openai',
  aiModel: 'openai/gpt-5.3-chat',
  includeDrivePrompt: false,
};

const validBody = {
  model: 'ps-agent://page-123',
  messages: [{ role: 'user', id: 'msg-1', content: 'Hello', parts: [{ type: 'text', text: 'Hello' }] }],
};

const makeRequest = (body: unknown, authHeader = 'Bearer mcp_test123') =>
  new Request('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/chat/completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([agentPage]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
  });

  test('returns 402 when the prepaid credit gate denies the request', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const response = await POST(makeRequest(validBody));
    const body = await response.json();
    assert({
      given: 'a user who is out of AI credits',
      should: 'return 402 with an out_of_credits error and not start the stream',
      actual: { status: response.status, error: body.error },
      expected: { status: 402, error: 'out_of_credits' },
    });
  });

  test('proceeds to a 200 stream when the credit gate allows', async () => {
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'ok' });
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a user with available credits (gate allowed)',
      should: 'return a 200 SSE stream',
      actual: { status: response.status, contentType: response.headers.get('content-type') },
      expected: { status: 200, contentType: 'text/event-stream' },
    });
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a request with no valid MCP token',
      should: 'return 401 Unauthorized',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 400 when model field is missing', async () => {
    const response = await POST(makeRequest({ messages: validBody.messages }));
    const body = await response.json();
    assert({
      given: 'a request body without a model field',
      should: 'return 400 with an error message',
      actual: { status: response.status, hasError: typeof body.error === 'string' },
      expected: { status: 400, hasError: true },
    });
  });

  test('returns 400 when model format is unsupported', async () => {
    const response = await POST(makeRequest({ ...validBody, model: 'gpt-4o' }));
    assert({
      given: 'a model string not starting with ps-agent://',
      should: 'return 400',
      actual: response.status,
      expected: 400,
    });
  });

  test('returns 403 when MCP scope check fails', async () => {
    vi.mocked(checkMCPPageScope).mockResolvedValue(
      NextResponse.json({ error: 'Scope violation' }, { status: 403 }),
    );
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a valid token that does not cover the requested agent page drive',
      should: 'return 403 Forbidden',
      actual: response.status,
      expected: 403,
    });
  });

  test('returns 404 when agent page does not exist', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a model URI pointing to a page that does not exist',
      should: 'return 404 Not Found',
      actual: response.status,
      expected: 404,
    });
  });

  test('returns 404 when page exists but is not an AI_CHAT type', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...agentPage, type: 'DOCUMENT' }]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a model URI pointing to a non-AI_CHAT page',
      should: 'return 404 Not Found',
      actual: response.status,
      expected: 404,
    });
  });

  test('returns 403 when the caller can view but cannot edit the agent page', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(canUserEditPage).mockResolvedValue(false);
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a view-only caller (no edit permission) on an agent that exposes write tools',
      should: 'return 403 so a view-only user cannot drive server-side tool writes',
      actual: response.status,
      expected: 403,
    });
  });

  test('returns 200 SSE stream with correct content-type on success', async () => {
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a valid MCP token, valid body, and an accessible agent page',
      should: 'return 200 with text/event-stream content-type',
      actual: {
        status: response.status,
        contentType: response.headers.get('content-type'),
      },
      expected: {
        status: 200,
        contentType: 'text/event-stream',
      },
    });
  });

  test('SSE stream contains OpenAI-shaped chunks', async () => {
    const response = await POST(makeRequest(validBody));
    const text = await response.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data:') && l !== 'data: [DONE]');
    const firstChunk = JSON.parse(lines[0].replace(/^data: /, ''));
    assert({
      given: 'a successful inference stream',
      should: 'emit OpenAI ChatCompletionChunk objects with the correct shape',
      actual: {
        hasId: typeof firstChunk.id === 'string',
        object: firstChunk.object,
        hasChoices: Array.isArray(firstChunk.choices) && firstChunk.choices.length > 0,
      },
      expected: {
        hasId: true,
        object: 'chat.completion.chunk',
        hasChoices: true,
      },
    });
  });

  test('does not require X-Browser-Session-Id header', async () => {
    const requestWithoutSessionId = new Request('http://localhost/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mcp_test123' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(requestWithoutSessionId);
    assert({
      given: 'a valid request without an X-Browser-Session-Id header',
      should: 'not return 400 (browser session ID is not required on this MCP-only path)',
      actual: response.status === 400,
      expected: false,
    });
  });

  test('calls AIMonitoring.trackUsage with token counts after stream completes', async () => {
    const response = await POST(makeRequest(validBody));
    await response.text();
    const calls = vi.mocked(AIMonitoring.trackUsage).mock.calls;
    assert({
      given: 'a successful inference stream',
      should: 'call AIMonitoring.trackUsage with inputTokens and outputTokens from totalUsage',
      actual: calls.length > 0
        ? { inputTokens: calls[0][0].inputTokens, outputTokens: calls[0][0].outputTokens, via: (calls[0][0].metadata as Record<string, unknown>)?.via }
        : null,
      expected: { inputTokens: 10, outputTokens: 5, via: 'openai_api_v1' },
    });
  });

  test('AIMonitoring.trackUsage failure does not break the SSE stream', async () => {
    vi.mocked(AIMonitoring.trackUsage).mockRejectedValueOnce(new Error('monitoring down'));
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'AIMonitoring.trackUsage throwing an error',
      should: 'still return a 200 SSE response',
      actual: { status: response.status, contentType: response.headers.get('content-type') },
      expected: { status: 200, contentType: 'text/event-stream' },
    });
  });

  test('thread mode: calls getMessagesForPage with pageId and conversationId', async () => {
    const dbMessages = [
      { id: 'db-1', pageId: 'page-123', conversationId: 'conv-abc', userId: 'user-1', role: 'user', content: 'Prior message', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null },
      { id: 'db-2', pageId: 'page-123', conversationId: 'conv-abc', userId: null, role: 'assistant', content: 'Prior response', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null },
    ];
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValueOnce(dbMessages);
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-abc' }));
    const calls = vi.mocked(chatMessageRepository.getMessagesForPage).mock.calls;
    assert({
      given: 'a request with a valid conversation_id',
      should: 'call getMessagesForPage with the pageId and conversationId and return 200',
      actual: {
        status: response.status,
        calledWithPageId: calls[0]?.[0],
        calledWithConvId: calls[0]?.[1],
      },
      expected: {
        status: 200,
        calledWithPageId: 'page-123',
        calledWithConvId: 'conv-abc',
      },
    });
  });

  test('thread mode: empty history is allowed (first message in thread)', async () => {
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValueOnce([]);
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-new' }));
    assert({
      given: 'a thread mode request where no prior messages exist',
      should: 'still return a 200 SSE stream',
      actual: response.status,
      expected: 200,
    });
  });

  test('thread mode: DB history messages are prepended before the new user message', async () => {
    const dbMessages = [
      { id: 'db-1', pageId: 'page-123', conversationId: 'conv-abc', userId: 'user-1', role: 'user', content: 'Prior question', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null },
      { id: 'db-2', pageId: 'page-123', conversationId: 'conv-abc', userId: null, role: 'assistant', content: 'Prior answer', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null },
    ];
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValueOnce(dbMessages);
    await POST(makeRequest({ ...validBody, conversation_id: 'conv-abc' }));
    const sanitizeCalls = vi.mocked(sanitizeMessagesForModel).mock.calls;
    assert({
      given: 'a thread mode request with 2 prior DB messages and 1 new user message',
      should: 'pass 3 messages to sanitizeMessagesForModel (2 history + 1 new)',
      actual: sanitizeCalls[0]?.[0]?.length,
      expected: 3,
    });
  });

  test('openai mode: caller-supplied system message is hoisted into the system prompt', async () => {
    // Extract real part text so the assertion can distinguish the caller's system content.
    vi.mocked(extractMessageContent).mockImplementation((m: UIMessage) =>
      (m.parts ?? [])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('')
    );
    await POST(makeRequest({
      model: 'ps-agent://page-123',
      messages: [
        { role: 'system', id: 'sys-1', content: 'Answer only JSON', parts: [{ type: 'text', text: 'Answer only JSON' }] },
        { role: 'user', id: 'msg-1', content: 'Hi', parts: [{ type: 'text', text: 'Hi' }] },
      ],
    }));
    const systemArg = vi.mocked(streamText).mock.calls[0]?.[0]?.system;
    assert({
      given: 'an OpenAI-style request carrying a caller system message',
      should: 'hoist the caller system content into the system: option instead of silently dropping it',
      actual: typeof systemArg === 'string' && systemArg.includes('Answer only JSON'),
      expected: true,
    });
  });

  test('openai mode: does not call getMessagesForPage when conversation_id is absent', async () => {
    await POST(makeRequest(validBody));
    assert({
      given: 'a request without a conversation_id',
      should: 'not call getMessagesForPage',
      actual: vi.mocked(chatMessageRepository.getMessagesForPage).mock.calls.length,
      expected: 0,
    });
  });

  test('whitespace-only conversation_id is treated as absent', async () => {
    await POST(makeRequest({ ...validBody, conversation_id: '   ' }));
    assert({
      given: 'a conversation_id containing only whitespace',
      should: 'not call getMessagesForPage',
      actual: vi.mocked(chatMessageRepository.getMessagesForPage).mock.calls.length,
      expected: 0,
    });
  });

  test('successful finish settles billing exactly once with success=true', async () => {
    const response = await POST(makeRequest(validBody));
    await response.text();
    const calls = vi.mocked(AIMonitoring.trackUsage).mock.calls;
    assert({
      given: 'a stream that finishes normally',
      should: 'call AIMonitoring.trackUsage exactly once with success=true and no aborted flag',
      actual: {
        count: calls.length,
        success: calls[0]?.[0]?.success,
        aborted: (calls[0]?.[0]?.metadata as Record<string, unknown> | undefined)?.aborted,
      },
      expected: { count: 1, success: true, aborted: undefined },
    });
  });

  test('consumer disconnect settles billing once as aborted and releases the hold', async () => {
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-xyz' });

    const ac = new AbortController();
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.resolve({ inputTokens: 7, outputTokens: 3 }),
      steps: Promise.resolve([]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 't1', delta: 'Partial' };
        // Simulate the consumer dropping the connection mid-stream: this trips the route's
        // abortController via request.signal. The SDK then ends the stream gracefully (no
        // throw), and the route settles using the abort signal state.
        ac.abort();
      },
    })) as unknown as typeof streamText);

    const req = new Request('http://localhost/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mcp_test123' },
      body: JSON.stringify(validBody),
      signal: ac.signal,
    });
    const response = await POST(req);
    await response.text();

    const calls = vi.mocked(AIMonitoring.trackUsage).mock.calls;
    assert({
      given: 'a consumer that disconnects mid-stream',
      should: 'settle billing once with holdId, success=false, and metadata.aborted=true',
      actual: {
        count: calls.length,
        holdId: calls[0]?.[0]?.holdId,
        success: calls[0]?.[0]?.success,
        aborted: (calls[0]?.[0]?.metadata as Record<string, unknown> | undefined)?.aborted,
        status: response.status,
      },
      expected: { count: 1, holdId: 'hold-xyz', success: false, aborted: true, status: 200 },
    });
  });

  test('request already aborted before streaming trips the model abort signal', async () => {
    let capturedSignalAborted: boolean | undefined;
    vi.mocked(streamText).mockImplementationOnce(((options: { abortSignal?: AbortSignal }) => {
      // Captured at call time: the route must hand streamText an already-aborted signal
      // when the consumer disconnected during the pre-stream setup.
      capturedSignalAborted = options.abortSignal?.aborted;
      return {
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
        steps: Promise.resolve([]),
        toUIMessageStream: async function* () {
          yield { type: 'start' };
        },
      };
    }) as unknown as typeof streamText);

    const preAborted = AbortSignal.abort();
    const req = new Request('http://localhost/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mcp_test123' },
      body: JSON.stringify(validBody),
      signal: preAborted,
    });
    const response = await POST(req);
    await response.text().catch(() => undefined);

    assert({
      given: 'a request whose signal is already aborted before generation starts',
      should: 'pass an already-aborted abortSignal to streamText so no tokens are burned',
      actual: capturedSignalAborted,
      expected: true,
    });
  });

  test('conversation ownership: returns 404 when conversation_id points to a non-existent conversation', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce(null);
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'no-such-conv' }));
    assert({
      given: 'a conversation_id that has no matching conversations row',
      should: 'return 404 before starting inference',
      actual: response.status,
      expected: 404,
    });
  });

  test('conversation ownership: returns 403 when conversation belongs to a different user', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-other',
      userId: 'other-user',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'client',
      lastMessageAt: null,
    });
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-other' }));
    assert({
      given: 'a conversation_id belonging to a different user',
      should: 'return 403 before starting inference',
      actual: response.status,
      expected: 403,
    });
  });

  test('conversation ownership: proceeds when conversation_id is absent', async () => {
    const response = await POST(makeRequest(validBody));
    assert({
      given: 'a request with no conversation_id',
      should: 'skip the ownership check and return 200',
      actual: response.status,
      expected: 200,
    });
  });

  test('client_manages_history: new conversation auto-creates row and uses client messages', async () => {
    // First getConversation call (ownership check): null — new session
    // Second getConversation call (TOCTOU verify after create): owned by caller
    vi.mocked(conversationRepository.getConversation)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'new-session-uuid',
        userId: 'user-1',
        isActive: true,
        title: null,
        contextId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        isShared: false,
        type: 'page',
        lastMessageAt: null,
      });
    const fullHistory = [
      { role: 'user', id: 'msg-0', content: 'First', parts: [{ type: 'text', text: 'First' }] },
      { role: 'assistant', id: 'msg-1', content: 'Hi', parts: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', id: 'msg-2', content: 'Second', parts: [{ type: 'text', text: 'Second' }] },
    ];
    const response = await POST(makeRequest({
      ...validBody,
      messages: fullHistory,
      conversation_id: 'new-session-uuid',
      client_manages_history: true,
    }));
    assert({
      given: 'client_manages_history=true with a brand-new conversation_id',
      should: 'return 200',
      actual: response.status,
      expected: 200,
    });
    assert({
      given: 'client_manages_history=true with a brand-new conversation_id',
      should: 'auto-create the conversations row',
      actual: vi.mocked(conversationRepository.createConversation).mock.calls.length,
      expected: 1,
    });
    const [streamCall] = vi.mocked(streamText).mock.calls;
    const passedMessages = (streamCall[0] as { messages: unknown[] }).messages;
    assert({
      given: 'client_manages_history=true',
      should: 'pass the full client message array to streamText (not just the last message)',
      actual: passedMessages.length,
      expected: fullHistory.length,
    });
  });

  test('client_manages_history: existing conversation owned by caller proceeds without DB history load', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-abc',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });
    const fullHistory = [
      { role: 'user', id: 'h-1', content: 'Turn 1', parts: [{ type: 'text', text: 'Turn 1' }] },
      { role: 'assistant', id: 'h-2', content: 'Reply', parts: [{ type: 'text', text: 'Reply' }] },
      { role: 'user', id: 'h-3', content: 'Turn 2', parts: [{ type: 'text', text: 'Turn 2' }] },
    ];
    const response = await POST(makeRequest({
      ...validBody,
      messages: fullHistory,
      conversation_id: 'conv-abc',
      client_manages_history: true,
    }));
    assert({
      given: 'client_manages_history=true and an existing conversation owned by the caller',
      should: 'return 200',
      actual: response.status,
      expected: 200,
    });
    assert({
      given: 'client_manages_history=true',
      should: 'not call chatMessageRepository.getMessagesForPage (no DB history load)',
      actual: vi.mocked(chatMessageRepository.getMessagesForPage).mock.calls.length,
      expected: 0,
    });
  });

  test('client_manages_history: returns 403 when conversation belongs to a different user', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-other',
      userId: 'other-user',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });
    const response = await POST(makeRequest({
      ...validBody,
      conversation_id: 'conv-other',
      client_manages_history: true,
    }));
    assert({
      given: 'client_manages_history=true but conversation_id belongs to a different user',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });

  test('client_manages_history: returns 404 when conversation row is inactive (soft-deleted)', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-deleted',
      userId: 'user-1',
      isActive: false,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: false,
      type: 'page',
      lastMessageAt: null,
    });
    const response = await POST(makeRequest({
      ...validBody,
      conversation_id: 'conv-deleted',
      client_manages_history: true,
    }));
    assert({
      given: 'client_manages_history=true and the conversation row exists but isActive=false',
      should: 'return 404, matching the normal thread-mode behaviour for inactive conversations',
      actual: response.status,
      expected: 404,
    });
  });

  test('client_manages_history: returns 403 when TOCTOU race means create was won by another user', async () => {
    // First read: null (our request sees no row)
    // After createConversation, second read: owned by a different user (race lost)
    vi.mocked(conversationRepository.getConversation)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'race-uuid',
        userId: 'other-user',
        isActive: true,
        title: null,
        contextId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        isShared: false,
        type: 'page',
        lastMessageAt: null,
      });
    const response = await POST(makeRequest({
      ...validBody,
      conversation_id: 'race-uuid',
      client_manages_history: true,
    }));
    assert({
      given: 'a TOCTOU race where another user\'s insert won before the ownership re-read',
      should: 'return 403 rather than silently appending messages to the wrong conversation',
      actual: response.status,
      expected: 403,
    });
  });

  test('tool call persistence: saves tool calls and results from steps with assistant message', async () => {
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 10 }),
      steps: Promise.resolve([
        {
          toolCalls: [{ toolCallId: 'call-1', toolName: 'read_page', input: { pageId: 'p-1' } }],
          toolResults: [{ toolCallId: 'call-1', toolName: 'read_page', output: 'page content' }],
        },
      ]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 't1', delta: 'Result text' };
        yield { type: 'finish' };
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest(validBody));
    await response.text();

    const saveCalls = vi.mocked(saveMessageToDatabase).mock.calls;
    const assistantSave = saveCalls.find((c) => c[0].role === 'assistant');
    assert({
      given: 'a stream with a step containing tool calls and results',
      should: 'save the assistant message with toolCalls and toolResults populated',
      actual: {
        hasToolCalls: Array.isArray(assistantSave?.[0]?.toolCalls) && (assistantSave![0].toolCalls as unknown[]).length > 0,
        hasToolResults: Array.isArray(assistantSave?.[0]?.toolResults) && (assistantSave![0].toolResults as unknown[]).length > 0,
      },
      expected: { hasToolCalls: true, hasToolResults: true },
    });
  });

  test('tool call persistence: no tool calls in steps means no toolCalls persisted', async () => {
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 10 }),
      steps: Promise.resolve([
        { toolCalls: [], toolResults: [] },
      ]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 't1', delta: 'Just text' };
        yield { type: 'finish' };
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest(validBody));
    await response.text();

    const saveCalls = vi.mocked(saveMessageToDatabase).mock.calls;
    const assistantSave = saveCalls.find((c) => c[0].role === 'assistant');
    assert({
      given: 'a stream with steps but no tool calls',
      should: 'save the assistant message without toolCalls or toolResults',
      actual: {
        toolCalls: assistantSave?.[0]?.toolCalls,
        toolResults: assistantSave?.[0]?.toolResults,
      },
      expected: { toolCalls: undefined, toolResults: undefined },
    });
  });

  test('tool call persistence: saves tool-only turn when no text but steps have tool calls', async () => {
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 3 }),
      steps: Promise.resolve([
        {
          toolCalls: [{ toolCallId: 'call-only', toolName: 'create_page', input: { title: 'New' } }],
          toolResults: [{ toolCallId: 'call-only', toolName: 'create_page', output: { id: 'p-2' } }],
        },
      ]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        // No text-delta — tool-only turn
        yield { type: 'finish' };
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-abc' }));
    await response.text();

    const saveCalls = vi.mocked(saveMessageToDatabase).mock.calls;
    const assistantSave = saveCalls.find((c) => c[0].role === 'assistant');
    assert({
      given: 'a tool-only turn with no text output but steps containing tool calls',
      should: 'save the assistant message with tool calls persisted',
      actual: {
        saved: assistantSave !== undefined,
        hasToolCalls: Array.isArray(assistantSave?.[0]?.toolCalls) && (assistantSave![0].toolCalls as unknown[]).length > 0,
      },
      expected: { saved: true, hasToolCalls: true },
    });
  });
});
