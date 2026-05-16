import { describe, test } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import {
  toChunk,
  toCompletion,
  sseEvent,
  SSE_DONE,
} from '../response-adapter';

const meta = { id: 'chatcmpl-abc', model: 'ps-agent://p1', created: 1700000000 };

describe('toChunk', () => {
  test('text delta with request metadata', () => {
    const chunk = toChunk(meta, { delta: 'Hel' });

    assert({
      given: 'a text delta and request metadata',
      should: 'produce a chat.completion.chunk whose first choice carries the delta',
      actual: {
        object: chunk.object,
        id: chunk.id,
        model: chunk.model,
        created: chunk.created,
        choice: chunk.choices[0],
      },
      expected: {
        object: 'chat.completion.chunk',
        id: 'chatcmpl-abc',
        model: 'ps-agent://p1',
        created: 1700000000,
        choice: { index: 0, delta: { content: 'Hel' }, finish_reason: null },
      },
    });
  });

  test('terminal chunk with stop finish reason', () => {
    const chunk = toChunk(meta, { finishReason: 'stop' });

    assert({
      given: 'a terminal chunk request',
      should: 'emit an empty delta with a stop finish reason',
      actual: chunk.choices[0],
      expected: { index: 0, delta: {}, finish_reason: 'stop' },
    });
  });
});

describe('toCompletion', () => {
  test('final text and token usage', () => {
    const completion = toCompletion(meta, {
      content: 'Hello world',
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    assert({
      given: 'final assembled text and token usage',
      should: 'produce a chat.completion reporting usage and a stop finish reason',
      actual: {
        object: completion.object,
        choice: completion.choices[0],
        usage: completion.usage,
      },
      expected: {
        object: 'chat.completion',
        choice: {
          index: 0,
          message: { role: 'assistant', content: 'Hello world' },
          finish_reason: 'stop',
        },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
  });
});

describe('sseEvent', () => {
  test('framing a chunk and the done sentinel', () => {
    assert({
      given: 'a payload object and the stream terminator',
      should: 'frame the payload as a data: SSE event and end with [DONE]',
      actual: {
        framed: sseEvent({ a: 1 }),
        done: SSE_DONE,
      },
      expected: {
        framed: 'data: {"a":1}\n\n',
        done: 'data: [DONE]\n\n',
      },
    });
  });
});
