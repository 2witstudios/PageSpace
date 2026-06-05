import { describe, test } from 'vitest';
import { assert } from './riteway';
import { buildToolSummaryEvent } from '../build-tool-summary-event';

describe('buildToolSummaryEvent', () => {
  test('returns null when no steps have tool calls', () => {
    const steps = [
      { toolCalls: [] },
      { toolCalls: [] },
    ];
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

  test('returns PAGESPACE_TOOL_SUMMARY SSE event when tool calls are present', () => {
    const steps = [
      { toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] },
    ];
    const result = buildToolSummaryEvent(steps);
    assert({
      given: 'a step with one tool call',
      should: 'return an SSE event with event:PAGESPACE_TOOL_SUMMARY',
      actual: typeof result === 'string' && result.startsWith('event: PAGESPACE_TOOL_SUMMARY'),
      expected: true,
    });
  });

  test('data field contains toolCalls array with toolName and toolCallId', () => {
    const steps = [
      { toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] },
      { toolCalls: [{ toolCallId: 'tc-2', toolName: 'read_page' }] },
    ];
    const result = buildToolSummaryEvent(steps);
    const dataLine = (result ?? '').split('\n').find(l => l.startsWith('data:'));
    const payload = dataLine ? JSON.parse(dataLine.replace(/^data: /, '')) : null;
    assert({
      given: 'two steps each with one tool call',
      should: 'include both tool calls in the toolCalls array',
      actual: payload?.toolCalls,
      expected: [
        { toolCallId: 'tc-1', toolName: 'search_web' },
        { toolCallId: 'tc-2', toolName: 'read_page' },
      ],
    });
  });

  test('data field includes stepCount', () => {
    const steps = [
      { toolCalls: [{ toolCallId: 'tc-1', toolName: 'search_web' }] },
      { toolCalls: [] },
      { toolCalls: [{ toolCallId: 'tc-2', toolName: 'read_page' }] },
    ];
    const result = buildToolSummaryEvent(steps);
    const dataLine = (result ?? '').split('\n').find(l => l.startsWith('data:'));
    const payload = dataLine ? JSON.parse(dataLine.replace(/^data: /, '')) : null;
    assert({
      given: '3 steps (2 with tool calls, 1 without)',
      should: 'include stepCount=3 in the payload',
      actual: payload?.stepCount,
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
    const result = buildToolSummaryEvent(steps);
    const dataLine = (result ?? '').split('\n').find(l => l.startsWith('data:'));
    const payload = dataLine ? JSON.parse(dataLine.replace(/^data: /, '')) : null;
    assert({
      given: 'two steps with 2 and 1 tool calls respectively',
      should: 'return 3 tool calls in a flat array',
      actual: payload?.toolCalls?.length,
      expected: 3,
    });
  });
});
