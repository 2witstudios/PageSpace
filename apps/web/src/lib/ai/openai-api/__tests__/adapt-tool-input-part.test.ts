import { describe, test } from 'vitest';
import { assert } from './riteway';
import { adaptToolInputPart } from '../adapt-tool-input-part';

const opts = { chunkId: 'cmpl-abc', model: 'ps-agent://page-123', created: 1000000000 };

describe('adaptToolInputPart', () => {
  test('returns an OpenAI tool call delta chunk', () => {
    const part = { toolCallId: 'tc-1', toolName: 'search_web', input: { query: 'weather today' } };
    const result = adaptToolInputPart(part, opts.chunkId, opts.model, opts.created, 0);
    assert({
      given: 'a complete tool-input-available part',
      should: 'return an OpenAI tool call chunk with id, function name, and serialized arguments',
      actual: result,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'tc-1',
              type: 'function',
              function: { name: 'search_web', arguments: '{"query":"weather today"}' },
            }],
          },
          finish_reason: null,
        }],
      },
    });
  });

  test('serializes complex object input as JSON arguments', () => {
    const part = { toolCallId: 'tc-2', toolName: 'create_page', input: { title: 'Notes', type: 'document', tags: ['a', 'b'] } };
    const result = adaptToolInputPart(part, opts.chunkId, opts.model, opts.created, 0);
    const argsStr = (result as { choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }> })
      .choices[0].delta.tool_calls[0].function.arguments;
    assert({
      given: 'a tool input with nested object',
      should: 'JSON-serialize the input as the arguments string',
      actual: JSON.parse(argsStr),
      expected: { title: 'Notes', type: 'document', tags: ['a', 'b'] },
    });
  });

  test('uses provided toolIndex in tool_calls[].index', () => {
    const part = { toolCallId: 'tc-3', toolName: 'read_page', input: {} };
    const result = adaptToolInputPart(part, opts.chunkId, opts.model, opts.created, 2);
    const toolIndex = (result as { choices: Array<{ delta: { tool_calls: Array<{ index: number }> } }> })
      .choices[0].delta.tool_calls[0].index;
    assert({
      given: 'toolIndex=2',
      should: 'set tool_calls[0].index to 2',
      actual: toolIndex,
      expected: 2,
    });
  });

  test('preserves chunk metadata (id, model, created)', () => {
    const part = { toolCallId: 'tc-1', toolName: 'noop', input: {} };
    const result = adaptToolInputPart(part, 'custom-id', 'my-model', 9999, 0) as {
      id: string; model: string; created: number;
    };
    assert({
      given: 'custom chunkId, model, and created values',
      should: 'carry them through to the chunk envelope',
      actual: { id: result.id, model: result.model, created: result.created },
      expected: { id: 'custom-id', model: 'my-model', created: 9999 },
    });
  });

  test('always sets finish_reason to null', () => {
    const part = { toolCallId: 'tc-1', toolName: 'noop', input: {} };
    const result = adaptToolInputPart(part, opts.chunkId, opts.model, opts.created, 0) as {
      choices: Array<{ finish_reason: unknown }>;
    };
    assert({
      given: 'any tool input part',
      should: 'set finish_reason to null (tool calls are not a terminal event)',
      actual: result.choices[0].finish_reason,
      expected: null,
    });
  });
});
