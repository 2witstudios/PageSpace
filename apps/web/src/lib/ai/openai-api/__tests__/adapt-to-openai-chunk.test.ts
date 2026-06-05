import { describe, test } from 'vitest';
import { assert } from './riteway';
import { adaptToOpenAIChunk } from '../adapt-to-openai-chunk';

const baseOpts = { id: 'cmpl-abc', model: 'ps-agent://page-123', created: 1000000000 };

const parseSSE = (line: string) => JSON.parse(line.replace(/^data: /, ''));

describe('adaptToOpenAIChunk', () => {
  test('start chunk produces opening delta with role:assistant', () => {
    const result = adaptToOpenAIChunk({ type: 'start' }, baseOpts);
    assert({
      given: 'a start chunk',
      should: 'produce an SSE line with delta.role=assistant and empty content',
      actual: result ? parseSSE(result) : null,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
    });
  });

  test('text-delta chunk produces content delta', () => {
    const result = adaptToOpenAIChunk({ type: 'text-delta', id: 'text-1', delta: ' Hello' }, baseOpts);
    assert({
      given: 'a text-delta chunk',
      should: 'produce an SSE line with delta.content set to the text delta',
      actual: result ? parseSSE(result) : null,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{ index: 0, delta: { content: ' Hello' }, finish_reason: null }],
      },
    });
  });

  test('finish chunk produces only the stop chunk (DONE is emitted by route)', () => {
    const result = adaptToOpenAIChunk({ type: 'finish' }, baseOpts);
    assert({
      given: 'a finish chunk',
      should: 'produce exactly the stop finish_reason SSE chunk — [DONE] is not included here',
      actual: result ? parseSSE(result) : null,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    });
  });

  test('tool-input-available chunk produces an OpenAI tool call delta', () => {
    const result = adaptToOpenAIChunk(
      { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: { q: 'hello' }, dynamic: false },
      { ...baseOpts, toolCallIndex: 0 },
    );
    assert({
      given: 'a tool-input-available chunk',
      should: 'produce an SSE line with delta.tool_calls containing the tool call',
      actual: result ? parseSSE(result) : null,
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
              function: { name: 'search', arguments: '{"q":"hello"}' },
            }],
          },
          finish_reason: null,
        }],
      },
    });
  });

  test('second tool-input-available in same step gets incremented tool index', () => {
    const result = adaptToOpenAIChunk(
      { type: 'tool-input-available', toolCallId: 'tc-2', toolName: 'read', input: { id: 'page-1' }, dynamic: false },
      { ...baseOpts, toolCallIndex: 1 },
    );
    const parsed = result ? parseSSE(result) : null;
    assert({
      given: 'a second tool-input-available chunk in the same step',
      should: 'use tool index 1 in tool_calls',
      actual: parsed?.choices[0]?.delta?.tool_calls?.[0]?.index,
      expected: 1,
    });
  });

  test('tool-output-available chunk produces an OpenAI tool result delta', () => {
    const result = adaptToOpenAIChunk(
      { type: 'tool-output-available', toolCallId: 'tc-1', output: 'search result text' },
      baseOpts,
    );
    assert({
      given: 'a tool-output-available chunk',
      should: 'produce an SSE line with delta.role=tool and the tool result as content',
      actual: result ? parseSSE(result) : null,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{
          index: 0,
          delta: { role: 'tool', tool_call_id: 'tc-1', content: 'search result text' },
          finish_reason: null,
        }],
      },
    });
  });

  test('finish-step chunk after tool calls emits finish_reason:tool_calls', () => {
    const result = adaptToOpenAIChunk(
      { type: 'finish-step' },
      { ...baseOpts, hadToolCallsInStep: true },
    );
    assert({
      given: 'a finish-step chunk after tool calls in the step',
      should: 'produce a finish_reason:tool_calls chunk',
      actual: result ? parseSSE(result) : null,
      expected: {
        id: 'cmpl-abc',
        object: 'chat.completion.chunk',
        created: 1000000000,
        model: 'ps-agent://page-123',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    });
  });

  test('finish-step chunk without tool calls returns null', () => {
    const result = adaptToOpenAIChunk(
      { type: 'finish-step' },
      { ...baseOpts, hadToolCallsInStep: false },
    );
    assert({
      given: 'a finish-step chunk without any tool calls in the step',
      should: 'return null',
      actual: result,
      expected: null,
    });
  });

  test('text-start chunk is skipped', () => {
    const result = adaptToOpenAIChunk({ type: 'text-start', id: 'text-1' }, baseOpts);
    assert({
      given: 'a text-start chunk (internal bookkeeping)',
      should: 'return null',
      actual: result,
      expected: null,
    });
  });

  test('finish chunk produces exactly one SSE event when stream encoder appends \\n\\n', () => {
    const result = adaptToOpenAIChunk({ type: 'finish' }, baseOpts);
    // [DONE] is now emitted separately by the route after buildToolSummaryEvent.
    // The finish chunk itself is a single stop-reason chunk.
    const encoded = (result ?? '') + '\n\n';
    const events = encoded.split('\n\n').filter(Boolean);
    assert({
      given: 'a finish chunk with the stream encoder\'s \\n\\n appended',
      should: 'produce exactly one SSE event — the stop-reason chunk (no inline [DONE])',
      actual: events.length,
      expected: 1,
    });
  });

  test('chunk includes stable id, model, and created timestamp', () => {
    const result = adaptToOpenAIChunk({ type: 'text-delta', id: 'text-1', delta: 'hi' }, baseOpts);
    const parsed = result ? parseSSE(result) : {};
    assert({
      given: 'any emitted chunk',
      should: 'carry the stable completion id, model name, and created timestamp',
      actual: { id: parsed.id, model: parsed.model, created: parsed.created },
      expected: { id: 'cmpl-abc', model: 'ps-agent://page-123', created: 1000000000 },
    });
  });
});
