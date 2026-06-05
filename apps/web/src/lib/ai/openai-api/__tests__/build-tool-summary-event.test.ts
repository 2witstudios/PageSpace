import { describe, test } from 'vitest';
import { assert } from './riteway';
import { buildToolSummaryEvent } from '../build-tool-summary-event';

const parsePayload = (result: string | null) => {
  if (!result) return null;
  const dataLine = result.split('\n').find(l => l.startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.replace(/^data: /, '')) : null;
};

describe('buildToolSummaryEvent', () => {
  test('returns null when no steps have tool calls', () => {
    const steps = [{ toolCalls: [] }, { toolCalls: [] }];
    assert({
      given: 'steps with no tool calls',
      should: 'return null — no summary to emit',
      actual: buildToolSummaryEvent(steps),
      expected: null,
    });
  });

  test('returns null for empty steps array', () => {
    assert({
      given: 'empty steps array',
      should: 'return null',
      actual: buildToolSummaryEvent([]),
      expected: null,
    });
  });

  test('returns null for a step with missing toolCalls property', () => {
    const steps = [{}];
    assert({
      given: 'a step with no toolCalls property at all',
      should: 'return null without throwing (treats missing as empty)',
      actual: buildToolSummaryEvent(steps as never),
      expected: null,
    });
  });

  test('emits a valid choices:[] chunk (not a named SSE event)', () => {
    const steps = [{ toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] }];
    const result = buildToolSummaryEvent(steps);
    assert({
      given: 'a step with one tool call',
      should: 'return a data: line with choices:[] so standard OpenAI clients skip it safely',
      actual: typeof result === 'string' && result.startsWith('data: ') && !result.startsWith('event:'),
      expected: true,
    });
  });

  test('payload has object:chat.completion.chunk and empty choices array', () => {
    const steps = [{ toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] }];
    const payload = parsePayload(buildToolSummaryEvent(steps));
    assert({
      given: 'a step with one tool call',
      should: 'include object and choices fields matching OpenAI chunk shape',
      actual: { object: payload?.object, choices: payload?.choices },
      expected: { object: 'chat.completion.chunk', choices: [] },
    });
  });

  test('x_pagespace_tool_summary contains toolCalls array with toolName and toolCallId', () => {
    const steps = [
      { toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] },
      { toolCalls: [{ toolCallId: 'tc-2', toolName: 'read_page' }] },
    ];
    const payload = parsePayload(buildToolSummaryEvent(steps));
    assert({
      given: 'two steps each with one tool call',
      should: 'include both tool calls in x_pagespace_tool_summary.toolCalls',
      actual: payload?.x_pagespace_tool_summary?.toolCalls,
      expected: [
        { toolCallId: 'tc-1', toolName: 'search_web' },
        { toolCallId: 'tc-2', toolName: 'read_page' },
      ],
    });
  });

  test('x_pagespace_tool_summary includes stepCount', () => {
    const steps = [
      { toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] },
      { toolCalls: [] },
      { toolCalls: [{ toolCallId: 'tc-2', toolName: 'read_page' }] },
    ];
    const payload = parsePayload(buildToolSummaryEvent(steps));
    assert({
      given: '3 steps (2 with tool calls, 1 without)',
      should: 'include stepCount=3 in x_pagespace_tool_summary',
      actual: payload?.x_pagespace_tool_summary?.stepCount,
      expected: 3,
    });
  });

  test('aggregates tool calls from multiple steps into flat list', () => {
    const steps = [
      { toolCalls: [
        { toolCallId: 'tc-1', toolName: 'search_web' },
        { toolCallId: 'tc-2', toolName: 'search_web' },
      ]},
      { toolCalls: [{ toolCallId: 'tc-3', toolName: 'read_page' }] },
    ];
    const payload = parsePayload(buildToolSummaryEvent(steps));
    assert({
      given: 'two steps with 2 and 1 tool calls respectively',
      should: 'return 3 tool calls in a flat array',
      actual: payload?.x_pagespace_tool_summary?.toolCalls?.length,
      expected: 3,
    });
  });
});
