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

  test('finish chunk produces stop + DONE sentinel', () => {
    const result = adaptToOpenAIChunk({ type: 'finish' }, baseOpts);
    const lines = result ? result.split('\n').filter(Boolean) : [];
    assert({
      given: 'a finish chunk',
      should: 'produce a stop finish_reason chunk followed by the [DONE] sentinel',
      actual: {
        stopChunk: lines[0] ? parseSSE(lines[0]) : null,
        done: lines[1],
      },
      expected: {
        stopChunk: {
          id: 'cmpl-abc',
          object: 'chat.completion.chunk',
          created: 1000000000,
          model: 'ps-agent://page-123',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        done: 'data: [DONE]',
      },
    });
  });

  test('tool-input-available chunk is skipped', () => {
    const result = adaptToOpenAIChunk(
      { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'search', input: {}, dynamic: false },
      baseOpts,
    );
    assert({
      given: 'a tool-input-available chunk',
      should: 'return null — tool calls are not exposed in v1',
      actual: result,
      expected: null,
    });
  });

  test('tool-output-available chunk is skipped', () => {
    const result = adaptToOpenAIChunk(
      { type: 'tool-output-available', toolCallId: 'tc-1', output: 'result' },
      baseOpts,
    );
    assert({
      given: 'a tool-output-available chunk',
      should: 'return null — tool results are not exposed in v1',
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
