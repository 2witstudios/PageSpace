import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { parseCompletionRequest } from '../request-adapter';

describe('parseCompletionRequest', () => {
  test('body missing model or messages', () => {
    const result = parseCompletionRequest({ messages: [{ role: 'user', content: 'hi' }] });

    assert({
      given: 'an OpenAI body with no model field',
      should: 'reject it as a malformed request in OpenAI error shape',
      actual: {
        ok: result.ok,
        status: result.ok ? null : result.status,
        type: result.ok ? null : result.error.type,
      },
      expected: { ok: false, status: 400, type: 'invalid_request_error' },
    });
  });

  test('messages mapped preserving role and text order', () => {
    const result = parseCompletionRequest({
      model: 'ps-agent://p1',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: 'hi there' },
      ],
    });

    assert({
      given: 'OpenAI messages with string and text-part content',
      should: 'produce internal model messages preserving role and text in order',
      actual: result.ok ? result.messages : result,
      expected: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
  });

  test('stream flag omitted', () => {
    const result = parseCompletionRequest({
      model: 'ps-agent://p1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert({
      given: 'a valid body that omits the stream flag',
      should: 'default the request to streaming',
      actual: result.ok ? result.stream : null,
      expected: true,
    });
  });

  test('stream flag explicitly false', () => {
    const result = parseCompletionRequest({
      model: 'ps-agent://p1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    assert({
      given: 'a valid body with stream explicitly false',
      should: 'treat the request as non-streaming',
      actual: result.ok ? result.stream : null,
      expected: false,
    });
  });
});
