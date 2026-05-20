import { describe, test } from 'vitest';
import { assert } from './riteway';
import { validateInferenceRequest } from '../validate-inference-request';

describe('validateInferenceRequest', () => {
  test('valid request', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hello', parts: [{ type: 'text' as const, text: 'Hello' }] }];
    const body = { model: 'ps-agent://page-123', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a valid ps-agent model URI and non-empty messages array',
      should: 'return ok:true with the parsed pageId, messages, stream:true, and no driveContext',
      actual: result,
      expected: { ok: true, data: { pageId: 'page-123', model: 'ps-agent://page-123', messages, stream: true, driveContext: undefined } },
    });
  });

  test('missing model field', () => {
    const body = { messages: [{ role: 'user', content: 'Hi' }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with no model field',
      should: 'return ok:false with status 400 and a descriptive error',
      actual: result,
      expected: { ok: false, status: 400, error: 'model is required' },
    });
  });

  test('model with unsupported format', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a model string that does not start with ps-agent://',
      should: 'return ok:false with status 400 instructing the correct format',
      actual: result,
      expected: { ok: false, status: 400, error: 'unsupported model format — use ps-agent://<pageId>' },
    });
  });

  test('empty messages array', () => {
    const body = { model: 'ps-agent://page-123', messages: [] };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an empty messages array',
      should: 'return ok:false with status 400',
      actual: result,
      expected: { ok: false, status: 400, error: 'messages must be a non-empty array' },
    });
  });

  test('missing messages field', () => {
    const body = { model: 'ps-agent://page-123' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with no messages field',
      should: 'return ok:false with status 400',
      actual: result,
      expected: { ok: false, status: 400, error: 'messages must be a non-empty array' },
    });
  });

  test('stream: false explicitly set', () => {
    const body = { model: 'ps-agent://page-123', messages: [{ role: 'user', content: 'Hi' }], stream: false };
    const result = validateInferenceRequest(body);
    assert({
      given: 'stream: false in the request body',
      should: 'return ok:false with status 400 because v1 is streaming-only',
      actual: result,
      expected: { ok: false, status: 400, error: 'non-streaming responses not supported in v1' },
    });
  });

  test('drive_context forwarded as driveContext', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, drive_context: 'drive-abc' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with a drive_context field',
      should: 'include driveContext in the parsed data',
      actual: result.ok ? result.data.driveContext : undefined,
      expected: 'drive-abc',
    });
  });

  test('stream omitted defaults to true', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-abc', messages };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with stream omitted',
      should: 'default stream to true in the parsed data',
      actual: result.ok ? result.data.stream : undefined,
      expected: true,
    });
  });

  test('plain OpenAI message (no parts) is normalized to UIMessage with parts', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: 'Hello from SDK' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a plain OpenAI SDK message with string content and no parts',
      should: 'return ok:true with the message normalized to UIMessage format (parts array with text part)',
      actual: result.ok
        ? {
            hasParts: Array.isArray(result.data.messages[0].parts),
            partType: result.data.messages[0].parts[0]?.type,
            partText: result.data.messages[0].parts[0]?.type === 'text'
              ? (result.data.messages[0].parts[0] as { type: 'text'; text: string }).text
              : undefined,
            hasId: typeof result.data.messages[0].id === 'string',
          }
        : undefined,
      expected: { hasParts: true, partType: 'text', partText: 'Hello from SDK', hasId: true },
    });
  });

  test('OpenAI content-array message is normalized to UIMessage with parts', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello array' }] }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'an OpenAI SDK message with content as an array of text blocks',
      should: 'return ok:true with parts extracted from the content array',
      actual: result.ok
        ? {
            hasParts: Array.isArray(result.data.messages[0].parts),
            partType: result.data.messages[0].parts[0]?.type,
          }
        : undefined,
      expected: { hasParts: true, partType: 'text' },
    });
  });

  test('null element in messages array returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [null],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a messages array containing a null element',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('message with unrecognized role returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'admin', content: 'Hi' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message with a role not in the allowed set (user, assistant, system, tool)',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('message with no content and no parts returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user' }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message with a valid role but no content and no parts',
      should: 'return ok:false with status 400',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('content-array message with no text parts returns 400', () => {
    const body = {
      model: 'ps-agent://page-123',
      messages: [{ role: 'user', content: [{ type: 'image', url: 'https://example.com/img.png' }] }],
    };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a message whose content array contains only non-text parts (e.g. image)',
      should: 'return ok:false with status 400 because no text content can be extracted',
      actual: { ok: result.ok, status: result.ok ? undefined : result.status },
      expected: { ok: false, status: 400 },
    });
  });

  test('conversation_id is extracted and returned as conversationId', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, conversation_id: 'conv-xyz' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a body with a conversation_id field',
      should: 'include conversationId in the parsed data',
      actual: result.ok ? result.data.conversationId : undefined,
      expected: 'conv-xyz',
    });
  });

  test('whitespace-only conversation_id is treated as absent', () => {
    const messages = [{ role: 'user' as const, id: 'msg-1', content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }] }];
    const body = { model: 'ps-agent://page-123', messages, conversation_id: '   ' };
    const result = validateInferenceRequest(body);
    assert({
      given: 'a conversation_id containing only whitespace',
      should: 'return undefined for conversationId',
      actual: result.ok ? result.data.conversationId : 'error',
      expected: undefined,
    });
  });
});
