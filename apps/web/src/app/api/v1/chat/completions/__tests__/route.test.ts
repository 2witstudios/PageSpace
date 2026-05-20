import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (must be hoisted before imports) ---

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    query: {
      chatMessages: { findMany: vi.fn().mockResolvedValue([]) },
    },
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
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'glm-4.5-air' }),
  buildSystemPrompt: vi.fn().mockReturnValue('You are a helpful agent.'),
  sanitizeMessagesForModel: vi.fn((msgs: unknown[]) => msgs),
  saveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  convertDbMessageToUIMessage: vi.fn((m: unknown) => {
    const msg = m as { id: string; role: string; content: string };
    return { id: msg.id, role: msg.role as 'user' | 'assistant', parts: [{ type: 'text' as const, text: msg.content || '' }] };
  }),
  extractMessageContent: vi.fn().mockReturnValue('Hello'),
  isProviderError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r && 'status' in r),
}));

vi.mock('@/lib/subscription/usage-service', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('test-id-123'),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: { getMessagesForPage: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn().mockImplementation((options: { onFinish?: (data: { text: string; totalUsage: { inputTokens: number; outputTokens: number } }) => Promise<void> }) => ({
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 'text-1', delta: 'Hello' };
        yield { type: 'finish' };
        if (options?.onFinish) {
          await options.onFinish({ text: 'Hello', totalUsage: { inputTokens: 10, outputTokens: 5 } });
        }
      },
    })),
  };
});

// --- imports after mocks ---
import { NextResponse } from 'next/server';
import { POST } from '../route';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';

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
  aiProvider: 'pagespace',
  aiModel: 'glm-4.5-air',
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
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([agentPage]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
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
});
