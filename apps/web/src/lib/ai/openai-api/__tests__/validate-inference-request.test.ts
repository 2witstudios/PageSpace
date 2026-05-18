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
      expected: { ok: true, data: { pageId: 'page-123', messages, stream: true, driveContext: undefined } },
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
});
