import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

const resolveInferenceContext = vi.fn();
const createAIProvider = vi.fn();
const streamText = vi.fn();

vi.mock('@/lib/ai/openai-api/context-resolver', () => ({
  resolveInferenceContext: (...a: unknown[]) => resolveInferenceContext(...a),
}));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: (...a: unknown[]) => createAIProvider(...a),
  isProviderError: (r: unknown) =>
    !!r && typeof r === 'object' && 'error' in r && 'status' in r,
}));
vi.mock('ai', () => ({ streamText: (...a: unknown[]) => streamText(...a) }));

import { POST } from '../route';

const okContext = {
  ok: true,
  context: {
    userId: 'u1',
    pageId: 'p1',
    page: { id: 'p1', title: 'Agent', type: 'AI_CHAT', driveId: 'd1', systemPrompt: 'be nice' },
  },
};

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer mcp_x' },
    body: JSON.stringify(body),
  });

async function* textChunks() {
  yield 'Hello';
  yield ' world';
}

describe('POST /api/v1/chat/completions', () => {
  beforeEach(() => {
    resolveInferenceContext.mockReset();
    createAIProvider.mockReset();
    streamText.mockReset();
    resolveInferenceContext.mockResolvedValue(okContext);
    createAIProvider.mockResolvedValue({ model: {}, provider: 'pagespace', modelName: 'm' });
  });

  test('streaming request', async () => {
    streamText.mockReturnValue({
      textStream: textChunks(),
      totalUsage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      text: Promise.resolve('Hello world'),
    });

    const res = await POST(
      makeRequest({
        model: 'ps-agent://p1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    );
    const text = await res.text();

    assert({
      given: 'a streaming completions request',
      should: 'return an SSE stream of OpenAI chunks ending with [DONE]',
      actual: {
        contentType: res.headers.get('content-type'),
        hasChunk: text.includes('"object":"chat.completion.chunk"'),
        hasContent: text.includes('Hello'),
        endsWithDone: text.trimEnd().endsWith('data: [DONE]'),
      },
      expected: {
        contentType: 'text/event-stream',
        hasChunk: true,
        hasContent: true,
        endsWithDone: true,
      },
    });
  });

  test('non-streaming request', async () => {
    streamText.mockReturnValue({
      textStream: textChunks(),
      totalUsage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      text: Promise.resolve('Hello world'),
    });

    const res = await POST(
      makeRequest({
        model: 'ps-agent://p1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    );
    const json = await res.json();

    assert({
      given: 'a non-streaming completions request',
      should: 'return a single OpenAI chat.completion JSON body',
      actual: {
        object: json.object,
        content: json.choices?.[0]?.message?.content,
        total: json.usage?.total_tokens,
      },
      expected: { object: 'chat.completion', content: 'Hello world', total: 5 },
    });
  });

  test('provider failure', async () => {
    createAIProvider.mockResolvedValue({ error: 'no provider', status: 503 });

    const res = await POST(
      makeRequest({
        model: 'ps-agent://p1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const json = await res.json();

    assert({
      given: 'a provider/upstream model failure',
      should: 'respond with an OpenAI-shaped error and the provider status',
      actual: { status: res.status, type: json.error?.type, message: json.error?.message },
      expected: { status: 503, type: 'api_error', message: 'no provider' },
    });
  });

  test('context resolution failure', async () => {
    resolveInferenceContext.mockResolvedValue({
      ok: false,
      status: 401,
      error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' },
    });

    const res = await POST(
      makeRequest({ model: 'ps-agent://p1', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const json = await res.json();

    assert({
      given: 'an authentication/authorization failure from the context resolver',
      should: 'propagate the OpenAI-shaped error and status',
      actual: { status: res.status, code: json.error?.code },
      expected: { status: 401, code: 'invalid_api_key' },
    });
  });
});
