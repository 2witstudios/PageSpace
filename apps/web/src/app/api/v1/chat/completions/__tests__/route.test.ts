// @vitest-environment node
// These are API route-handler tests with no DOM needs. The default jsdom env
// makes AbortController/AbortSignal jsdom globals while Request stays Node's
// undici, so on Node >=24 `new Request(url, { signal })` throws because the
// jsdom AbortSignal fails undici's `instanceof AbortSignal` check. Running this
// file under the node env keeps both on the same (undici) implementation.
import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (must be hoisted before imports) ---

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  isMCPAuthResult: vi.fn((r: unknown) => (r as { tokenType?: string })?.tokenType === 'mcp'),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn(() => []),
  isScopedMCPAuth: vi.fn(() => false),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  canPrincipalEditPage: vi.fn().mockResolvedValue(true),
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
vi.mock('@/lib/ai/core/ai-tools', async () => {
  const { toModelOutputForReadPage } = await import('@/lib/ai/tools/read-page-vision-output');
  return {
    pageSpaceTools: {
      // Mirrors the real read_page tool's toModelOutput wiring (page-read-tools.ts)
      // so the cross-turn vision guard test below exercises the real mapper/guard.
      read_page: {
        name: 'read_page',
        toModelOutput: ({ output }: { output: unknown }) => toModelOutputForReadPage(output),
        execute: async () => ({}),
      },
    },
  };
});
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  filterToolsForReadOnly: vi.fn((tools: unknown) => tools),
  filterToolsForMcpScope: vi.fn((tools: unknown) => tools),
  filterToolsForImageGen: vi.fn((tools: unknown) => tools),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  hasVisionCapability: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  hasFileParts: vi.fn().mockReturnValue(false),
  validateUserMessageFileParts: vi.fn().mockReturnValue({ valid: true, filePartCount: 0 }),
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

vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: vi.fn().mockResolvedValue(undefined),
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
import { canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { sanitizeMessagesForModel, extractMessageContent, saveMessageToDatabase } from '@/lib/ai/core/message-utils';
import type { UIMessage } from 'ai';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { hasFileParts, validateUserMessageFileParts } from '@/lib/ai/core/validate-image-parts';

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
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(canPrincipalEditPage).mockResolvedValue(true);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([agentPage]),
      }),
    } as unknown as ReturnType<typeof db.select>);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);
    vi.mocked(canConsumeAI).mockResolvedValue({ allowed: true, reason: 'unlimited' });
    vi.mocked(hasFileParts).mockReturnValue(false);
    vi.mocked(hasVisionCapability).mockReturnValue(true);
    vi.mocked(validateUserMessageFileParts).mockReturnValue({ valid: true, filePartCount: 0 });
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

  test('returns 400 and never touches the credit gate when an image is sent to a non-vision model', async () => {
    vi.mocked(hasFileParts).mockReturnValue(true);
    vi.mocked(hasVisionCapability).mockReturnValue(false);
    const bodyWithImage = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'user',
        id: 'msg-1',
        content: 'What is in this image?',
        parts: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' },
        ],
      }],
    };
    const response = await POST(makeRequest(bodyWithImage));
    const body = await response.json();
    assert({
      given: 'a user message with a file part sent to an agent configured with a non-vision model',
      should: 'return 400 with a descriptive error and never call the prepaid credit gate',
      actual: { status: response.status, error: body.error, creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0 },
      expected: {
        status: 400,
        error: `The selected model "${agentPage.aiModel}" does not support image attachments. Please choose a vision-capable model.`,
        creditGateCalled: false,
      },
    });
  });

  test('returns 400 when file-part validation fails, before the credit gate', async () => {
    vi.mocked(hasFileParts).mockReturnValue(true);
    vi.mocked(validateUserMessageFileParts).mockReturnValue({ valid: false, error: 'Image "cat.png" exceeds the 4MB size limit', filePartCount: 1 });
    const bodyWithImage = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'user',
        id: 'msg-1',
        content: 'What is in this image?',
        parts: [{ type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
      }],
    };
    const response = await POST(makeRequest(bodyWithImage));
    const body = await response.json();
    assert({
      given: 'a user message with a file part that fails size/format validation',
      should: 'return 400 with the validation error and never call the prepaid credit gate',
      actual: { status: response.status, error: body.error, creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0 },
      expected: { status: 400, error: 'Image "cat.png" exceeds the 4MB size limit', creditGateCalled: false },
    });
  });

  test('validates file parts in earlier user messages, not just the final one', async () => {
    vi.mocked(hasFileParts).mockImplementation((message: UIMessage) => message.id === 'msg-1');
    vi.mocked(validateUserMessageFileParts).mockReturnValue({ valid: false, error: 'Image "cat.png" exceeds the 4MB size limit', filePartCount: 1 });
    const bodyWithEarlierImage = {
      model: 'ps-agent://page-123',
      messages: [
        {
          role: 'user',
          id: 'msg-1',
          content: 'What is in this image?',
          parts: [{ type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
        },
        { role: 'assistant', id: 'msg-2', content: 'A cat.', parts: [{ type: 'text', text: 'A cat.' }] },
        { role: 'user', id: 'msg-3', content: 'Thanks!', parts: [{ type: 'text', text: 'Thanks!' }] },
      ],
    };
    const response = await POST(makeRequest(bodyWithEarlierImage));
    const body = await response.json();
    assert({
      given: 'a resent full history where only an EARLIER user message carries an invalid file part and the final message is text-only',
      should: 'still return 400 from file-part validation and never call the prepaid credit gate',
      actual: { status: response.status, error: body.error, creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0 },
      expected: { status: 400, error: 'Image "cat.png" exceeds the 4MB size limit', creditGateCalled: false },
    });
  });

  test('applies the vision-capability gate to images in earlier user messages', async () => {
    vi.mocked(hasFileParts).mockImplementation((message: UIMessage) => message.id === 'msg-1');
    vi.mocked(hasVisionCapability).mockReturnValue(false);
    const bodyWithEarlierImage = {
      model: 'ps-agent://page-123',
      messages: [
        {
          role: 'user',
          id: 'msg-1',
          content: 'What is in this image?',
          parts: [{ type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
        },
        { role: 'assistant', id: 'msg-2', content: 'A cat.', parts: [{ type: 'text', text: 'A cat.' }] },
        { role: 'user', id: 'msg-3', content: 'Thanks!', parts: [{ type: 'text', text: 'Thanks!' }] },
      ],
    };
    const response = await POST(makeRequest(bodyWithEarlierImage));
    const body = await response.json();
    assert({
      given: 'a resent full history with a valid image in an EARLIER user message and a non-vision model',
      should: 'return 400 from the vision gate and never call the prepaid credit gate',
      actual: { status: response.status, error: body.error, creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0 },
      expected: {
        status: 400,
        error: `The selected model "${agentPage.aiModel}" does not support image attachments. Please choose a vision-capable model.`,
        creditGateCalled: false,
      },
    });
  });

  test('rejects invalid file parts on assistant-role messages too', async () => {
    vi.mocked(hasFileParts).mockImplementation((message: UIMessage) => message.role === 'assistant');
    vi.mocked(validateUserMessageFileParts).mockReturnValue({ valid: false, error: 'Image "x.png" is not a valid data URL', filePartCount: 1 });
    const bodyWithAssistantImage = {
      model: 'ps-agent://page-123',
      messages: [
        { role: 'user', id: 'msg-1', content: 'Draw a cat.', parts: [{ type: 'text', text: 'Draw a cat.' }] },
        {
          role: 'assistant',
          id: 'msg-2',
          content: '',
          parts: [{ type: 'file', url: 'https://attacker.example/x.png', mediaType: 'image/png' }],
        },
        { role: 'user', id: 'msg-3', content: 'Another one.', parts: [{ type: 'text', text: 'Another one.' }] },
      ],
    };
    const response = await POST(makeRequest(bodyWithAssistantImage));
    const body = await response.json();
    assert({
      given: 'a resent history where an ASSISTANT-role message carries an invalid file part (e.g. a remote URL)',
      should: 'return 400 from file-part validation instead of letting non-user roles bypass the gate',
      actual: { status: response.status, error: body.error, creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0 },
      expected: { status: 400, error: 'Image "x.png" is not a valid data URL', creditGateCalled: false },
    });
  });

  test('a valid image on a vision-capable model passes the gate and reaches the credit gate', async () => {
    vi.mocked(hasFileParts).mockReturnValue(true);
    const bodyWithImage = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'user',
        id: 'msg-1',
        content: 'What is in this image?',
        parts: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' },
        ],
      }],
    };
    const response = await POST(makeRequest(bodyWithImage));
    assert({
      given: 'a valid image sent to a vision-capable model by an authorized caller with credits',
      should: 'proceed through the image gate to the credit gate and return a 200 SSE stream',
      actual: {
        status: response.status,
        contentType: response.headers.get('content-type'),
        creditGateCalled: vi.mocked(canConsumeAI).mock.calls.length > 0,
      },
      expected: { status: 200, contentType: 'text/event-stream', creditGateCalled: true },
    });
  });

  test('returns 403 to a caller without page access before any vision error can reveal the agent model', async () => {
    vi.mocked(canPrincipalViewPage).mockResolvedValue(false);
    vi.mocked(hasFileParts).mockReturnValue(true);
    vi.mocked(hasVisionCapability).mockReturnValue(false);
    const bodyWithImage = {
      model: 'ps-agent://page-123',
      messages: [{
        role: 'user',
        id: 'msg-1',
        content: 'What is in this image?',
        parts: [{ type: 'file', url: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
      }],
    };
    const response = await POST(makeRequest(bodyWithImage));
    const body = await response.json();
    assert({
      given: 'an authenticated caller with a valid image who lacks view permission on a non-vision agent page',
      should: 'return the permission 403 rather than the vision 400 that would leak the configured model',
      actual: { status: response.status, error: body.error, leaksModel: String(body.error).includes(String(agentPage.aiModel)) },
      expected: { status: 403, error: 'Access denied', leaksModel: false },
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
    vi.mocked(canPrincipalViewPage).mockResolvedValue(true);
    vi.mocked(canPrincipalEditPage).mockResolvedValue(false);
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
      { id: 'db-1', pageId: 'page-123', conversationId: 'conv-abc', userId: 'user-1', role: 'user', content: 'Prior message', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null, status: 'complete' as const },
      { id: 'db-2', pageId: 'page-123', conversationId: 'conv-abc', userId: null, role: 'assistant', content: 'Prior response', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null, status: 'complete' as const },
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
      { id: 'db-1', pageId: 'page-123', conversationId: 'conv-abc', userId: 'user-1', role: 'user', content: 'Prior question', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null, status: 'complete' as const },
      { id: 'db-2', pageId: 'page-123', conversationId: 'conv-abc', userId: null, role: 'assistant', content: 'Prior answer', messageType: 'standard' as const, isActive: true, createdAt: new Date(), editedAt: null, toolCalls: null, toolResults: null, status: 'complete' as const },
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

  test('cross-turn vision guard: read_page degrades a stale visual_content_delivered result when the requested model lacks vision', async () => {
    vi.mocked(hasVisionCapability).mockReturnValueOnce(false);
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 10 }),
      steps: Promise.resolve([]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'finish' };
      },
    })) as unknown as typeof streamText);

    await POST(makeRequest(validBody));

    const toolsArg = vi.mocked(streamText).mock.calls[0]?.[0]?.tools as
      | Record<string, { toModelOutput?: (args: { output: unknown }) => unknown }>
      | undefined;
    const readPageTool = toolsArg?.read_page;
    const visualDeliveredOutput = {
      success: true,
      type: 'visual_content_delivered',
      pageId: 'page-1',
      title: 'diagram.png',
      mimeType: 'image/jpeg',
      originalMimeType: 'image/png',
      message: 'Delivered visual content: "diagram.png" (image/jpeg)',
      imageBase64: 'ZmFrZS1iYXNlNjQ=',
      sizeBytes: 1234,
      metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
    };

    const modelOutput = readPageTool!.toModelOutput!({ output: visualDeliveredOutput }) as { type: string; value: Record<string, unknown> };
    assert({
      given: 'a request whose resolved model lacks vision and a stale visual_content_delivered read_page result',
      should: 'degrade to visual_content_metadata rather than re-embedding the image bytes',
      actual: { type: modelOutput.type, innerType: modelOutput.value.type, containsBase64: JSON.stringify(modelOutput).includes(visualDeliveredOutput.imageBase64) },
      expected: { type: 'json', innerType: 'visual_content_metadata', containsBase64: false },
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

  // --- Credit-hold leak regressions (audit findings L6, L7) ---

  test('L6: a pre-stream setup throw releases the hold and never reaches the model', async () => {
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-setup' });
    // Persisting the user message is the last awaited setup step before streamText. A failure
    // here must NOT strand the gate's hold + in-flight slot until TTL.
    vi.mocked(saveMessageToDatabase).mockRejectedValueOnce(new Error('db write failed'));

    const response = await POST(makeRequest(validBody));

    assert({
      given: 'a throw during pre-stream setup (user-message persistence) after the hold is placed',
      should: 'return 500, release the hold exactly once, never call streamText, and never settle usage',
      actual: {
        status: response.status,
        releaseCalls: vi.mocked(releaseHold).mock.calls.length,
        releasedHoldId: vi.mocked(releaseHold).mock.calls[0]?.[0],
        streamTextCalls: vi.mocked(streamText).mock.calls.length,
        trackUsageCalls: vi.mocked(AIMonitoring.trackUsage).mock.calls.length,
      },
      expected: {
        status: 500,
        releaseCalls: 1,
        releasedHoldId: 'hold-setup',
        streamTextCalls: 0,
        trackUsageCalls: 0,
      },
    });
  });

  test('L6: a successful stream hands the hold off — the setup finally does not release it', async () => {
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-ok' });

    const response = await POST(makeRequest(validBody));
    await response.text();

    assert({
      given: 'a request that reaches the streaming Response',
      should: 'hand the hold to the stream lifecycle (settle billed it) and not double-release in finally',
      actual: {
        status: response.status,
        releaseCalls: vi.mocked(releaseHold).mock.calls.length,
        trackUsageHoldId: vi.mocked(AIMonitoring.trackUsage).mock.calls[0]?.[0]?.holdId,
      },
      expected: { status: 200, releaseCalls: 0, trackUsageHoldId: 'hold-ok' },
    });
  });

  test('L7: a mid-stream (non-abort) error settles partial usage as a failure before releasing', async () => {
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-l7' });
    vi.mocked(streamText).mockImplementationOnce((() => ({
      // Partial spend the provider already burned before the error.
      totalUsage: Promise.resolve({ inputTokens: 12, outputTokens: 4 }),
      steps: Promise.resolve([]),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 't1', delta: 'Half a thought' };
        // A genuine provider error mid-stream (NOT a consumer abort).
        throw new Error('provider exploded mid-stream');
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest(validBody));
    // The route propagates the error via controller.error after settling; draining throws.
    await response.text().catch(() => undefined);

    const calls = vi.mocked(AIMonitoring.trackUsage).mock.calls;
    assert({
      given: 'a provider error mid-stream after tokens were burned',
      should: 'bill the partial usage once as a failed run (success=false, errored) with the holdId, and NOT release the hold (settle consumes it)',
      actual: {
        trackUsageCalls: calls.length,
        holdId: calls[0]?.[0]?.holdId,
        success: calls[0]?.[0]?.success,
        inputTokens: calls[0]?.[0]?.inputTokens,
        errored: (calls[0]?.[0]?.metadata as Record<string, unknown> | undefined)?.errored,
        releaseCalls: vi.mocked(releaseHold).mock.calls.length,
      },
      expected: {
        trackUsageCalls: 1,
        holdId: 'hold-l7',
        success: false,
        inputTokens: 12,
        errored: true,
        releaseCalls: 0,
      },
    });
  });

  test('L7: a mid-stream error with no burned usage releases the hold without billing', async () => {
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-empty' });
    vi.mocked(streamText).mockImplementationOnce((() => ({
      // No usage/steps ever materialised before the failure.
      totalUsage: Promise.reject(new Error('no usage')),
      steps: Promise.reject(new Error('no steps')),
      toUIMessageStream: async function* () {
        throw new Error('failed before any output');
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest(validBody));
    await response.text().catch(() => undefined);

    assert({
      given: 'a mid-stream error before any tokens were burned',
      should: 'release the hold once with its id and record no usage',
      actual: {
        releaseCalls: vi.mocked(releaseHold).mock.calls.length,
        releasedHoldId: vi.mocked(releaseHold).mock.calls[0]?.[0],
        trackUsageCalls: vi.mocked(AIMonitoring.trackUsage).mock.calls.length,
      },
      expected: { releaseCalls: 1, releasedHoldId: 'hold-empty', trackUsageCalls: 0 },
    });
  });

  test('L7: streamed text with no token counts releases the hold instead of settling a $0 row', async () => {
    // Codex P1: a partial-output error where text was emitted but the usage/steps promises
    // reject leaves NO billable token counts. Settling here would record a misleading $0 usage
    // row (trackUsage skips consumeCredits for a failed run with totalTokens===0) — so the
    // disposition must be a plain release, NOT settle-partial, even though text streamed.
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-textonly' });
    vi.mocked(streamText).mockImplementationOnce((() => ({
      totalUsage: Promise.reject(new Error('usage unavailable')),
      steps: Promise.reject(new Error('steps unavailable')),
      toUIMessageStream: async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 't1', delta: 'A partial answer with no accounting' };
        throw new Error('provider dropped after partial text');
      },
    })) as unknown as typeof streamText);

    const response = await POST(makeRequest(validBody));
    await response.text().catch(() => undefined);

    assert({
      given: 'a mid-stream error after streaming text but with no recoverable token counts',
      should: 'release the hold once and NOT call trackUsage (no misleading $0 settle)',
      actual: {
        releaseCalls: vi.mocked(releaseHold).mock.calls.length,
        releasedHoldId: vi.mocked(releaseHold).mock.calls[0]?.[0],
        trackUsageCalls: vi.mocked(AIMonitoring.trackUsage).mock.calls.length,
      },
      expected: { releaseCalls: 1, releasedHoldId: 'hold-textonly', trackUsageCalls: 0 },
    });
  });

  test('L6: the setup-phase hold release is awaited before the 500 returns (not fire-and-forget)', async () => {
    // Codex P2: the setup-error path returns a plain JSON 500 with no stream keeping the
    // runtime alive, so the release must be awaited — a fire-and-forget release could be
    // abandoned if a serverless runtime freezes after the response. We prove the await by
    // resolving releaseHold only after a deferred tick and asserting it has settled by the
    // time POST resolves.
    vi.mocked(canConsumeAI).mockResolvedValueOnce({ allowed: true, reason: 'unlimited', holdId: 'hold-awaited' });
    vi.mocked(saveMessageToDatabase).mockRejectedValueOnce(new Error('db write failed'));
    let released = false;
    vi.mocked(releaseHold).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(() => { released = true; resolve(); }, 0)),
    );

    const response = await POST(makeRequest(validBody));

    assert({
      given: 'a pre-stream setup failure whose hold release resolves on a later tick',
      should: 'await the release so it has completed by the time the 500 response is returned',
      actual: { status: response.status, released },
      expected: { status: 500, released: true },
    });
  });

  test('mention notifications: omits mentionNotify for private conversations (isShared=false)', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-private',
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
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-private' }));
    await response.text();

    const saveCalls = vi.mocked(saveMessageToDatabase).mock.calls;
    const assistantSave = saveCalls.find((c) => c[0].role === 'assistant');
    assert({
      given: 'an assistant message in a private conversation (isShared=false)',
      should: 'not include mentionNotify in the saveMessageToDatabase call',
      actual: assistantSave?.[0]?.mentionNotify,
      expected: undefined,
    });
  });

  test('mention notifications: includes mentionNotify for shared conversations (isShared=true)', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValueOnce({
      id: 'conv-shared',
      userId: 'user-1',
      isActive: true,
      title: null,
      contextId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      isShared: true,
      type: 'page',
      lastMessageAt: null,
    });
    const response = await POST(makeRequest({ ...validBody, conversation_id: 'conv-shared' }));
    await response.text();

    const saveCalls = vi.mocked(saveMessageToDatabase).mock.calls;
    const assistantSave = saveCalls.find((c) => c[0].role === 'assistant');
    assert({
      given: 'an assistant message in a shared conversation (isShared=true)',
      should: 'include mentionNotify in the saveMessageToDatabase call',
      actual: typeof assistantSave?.[0]?.mentionNotify,
      expected: 'object',
    });
  });
});
