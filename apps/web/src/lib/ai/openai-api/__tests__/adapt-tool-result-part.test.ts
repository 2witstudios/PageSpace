import { describe, test } from 'vitest';
import { assert } from './riteway';
import { adaptToolResultPart } from '../adapt-tool-result-part';

const opts = { chunkId: 'cmpl-abc', model: 'ps-agent://page-123', created: 1000000000 };

describe('adaptToolResultPart', () => {
  test('returns an OpenAI tool result delta chunk for string output', () => {
    const part = { toolCallId: 'tc-1', output: 'search results text' };
    const result = adaptToolResultPart(part, opts.chunkId, opts.model, opts.created);
    assert({
      given: 'a tool-output-available part with string output',
      should: 'return a chunk with delta.role=tool and output as content',
      actual: result,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{
          index: 0,
          delta: { role: 'tool', tool_call_id: 'tc-1', content: 'search results text' },
          finish_reason: null,
        }],
      },
    });
  });

  test('JSON-serializes object output as content', () => {
    const part = { toolCallId: 'tc-2', output: { pages: ['a', 'b'], total: 2 } };
    const result = adaptToolResultPart(part, opts.chunkId, opts.model, opts.created) as {
      choices: Array<{ delta: { content: string } }>;
    };
    assert({
      given: 'a tool output with object value',
      should: 'JSON-serialize the output as content',
      actual: JSON.parse(result.choices[0].delta.content),
      expected: { pages: ['a', 'b'], total: 2 },
    });
  });

  test('JSON-serializes array output as content', () => {
    const part = { toolCallId: 'tc-3', output: [1, 2, 3] };
    const result = adaptToolResultPart(part, opts.chunkId, opts.model, opts.created) as {
      choices: Array<{ delta: { content: string } }>;
    };
    assert({
      given: 'a tool output with array value',
      should: 'JSON-serialize the array as content',
      actual: JSON.parse(result.choices[0].delta.content),
      expected: [1, 2, 3],
    });
  });

  test('carries tool_call_id through to delta', () => {
    const part = { toolCallId: 'specific-call-id', output: 'ok' };
    const result = adaptToolResultPart(part, opts.chunkId, opts.model, opts.created) as {
      choices: Array<{ delta: { tool_call_id: string } }>;
    };
    assert({
      given: 'a tool output with a specific toolCallId',
      should: 'set delta.tool_call_id to match',
      actual: result.choices[0].delta.tool_call_id,
      expected: 'specific-call-id',
    });
  });

  test('always sets finish_reason to null', () => {
    const part = { toolCallId: 'tc-1', output: 'done' };
    const result = adaptToolResultPart(part, opts.chunkId, opts.model, opts.created) as {
      choices: Array<{ finish_reason: unknown }>;
    };
    assert({
      given: 'any tool result part',
      should: 'set finish_reason to null',
      actual: result.choices[0].finish_reason,
      expected: null,
    });
  });
});
