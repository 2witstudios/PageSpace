import { describe, test } from 'vitest';
import { assert } from './riteway';
import { extractToolCallsFromSteps } from '../extract-tool-calls-from-steps';

const makeStep = (
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [],
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }> = [],
) => ({ toolCalls, toolResults });

describe('extractToolCallsFromSteps', () => {
  test('empty steps returns empty arrays', () => {
    const result = extractToolCallsFromSteps([]);
    assert({
      given: 'an empty steps array',
      should: 'return empty toolCalls and toolResults arrays',
      actual: result,
      expected: { toolCalls: [], toolResults: [] },
    });
  });

  test('step with no tool calls returns empty arrays', () => {
    const result = extractToolCallsFromSteps([makeStep()]);
    assert({
      given: 'a step with no tool calls or results',
      should: 'return empty arrays',
      actual: result,
      expected: { toolCalls: [], toolResults: [] },
    });
  });

  test('step with tool calls and matching results collects both', () => {
    const step = makeStep(
      [{ toolCallId: 'call-1', toolName: 'read_page', input: { pageId: 'p-1' } }],
      [{ toolCallId: 'call-1', toolName: 'read_page', output: 'page content' }],
    );
    const result = extractToolCallsFromSteps([step]);
    assert({
      given: 'a step with one tool call and matching result',
      should: 'return one toolCall with state output-available and one toolResult',
      actual: {
        callCount: result.toolCalls.length,
        resultCount: result.toolResults.length,
        callState: result.toolCalls[0]?.state,
        callId: result.toolCalls[0]?.toolCallId,
        resultOutput: result.toolResults[0]?.output,
      },
      expected: {
        callCount: 1,
        resultCount: 1,
        callState: 'output-available',
        callId: 'call-1',
        resultOutput: 'page content',
      },
    });
  });

  test('tool call without a result gets state input-available', () => {
    const step = makeStep(
      [{ toolCallId: 'call-orphan', toolName: 'create_page', input: { title: 'T' } }],
      [],
    );
    const result = extractToolCallsFromSteps([step]);
    assert({
      given: 'a tool call with no matching result',
      should: 'set state to input-available',
      actual: result.toolCalls[0]?.state,
      expected: 'input-available',
    });
  });

  test('multiple steps all have their tool calls collected', () => {
    const steps = [
      makeStep(
        [{ toolCallId: 'call-1', toolName: 'read_page', input: {} }],
        [{ toolCallId: 'call-1', toolName: 'read_page', output: 'r1' }],
      ),
      makeStep(
        [{ toolCallId: 'call-2', toolName: 'create_page', input: {} }],
        [{ toolCallId: 'call-2', toolName: 'create_page', output: 'r2' }],
      ),
    ];
    const result = extractToolCallsFromSteps(steps);
    assert({
      given: 'two steps each with one tool call and result',
      should: 'return two toolCalls and two toolResults',
      actual: { callCount: result.toolCalls.length, resultCount: result.toolResults.length },
      expected: { callCount: 2, resultCount: 2 },
    });
  });

  test('non-step-like elements in the array are ignored', () => {
    const result = extractToolCallsFromSteps([null, undefined, 'string', 42, {}, { toolCalls: 'not-array', toolResults: [] }]);
    assert({
      given: 'an array with various non-step-like elements',
      should: 'ignore them and return empty arrays',
      actual: result,
      expected: { toolCalls: [], toolResults: [] },
    });
  });

  test('tool call input is preserved with correct type', () => {
    const input = { pageId: 'p-1', title: 'My Page' };
    const step = makeStep(
      [{ toolCallId: 'call-1', toolName: 'update_page', input }],
      [],
    );
    const result = extractToolCallsFromSteps([step]);
    assert({
      given: 'a tool call with a structured input object',
      should: 'preserve the input object',
      actual: result.toolCalls[0]?.input,
      expected: input,
    });
  });

  test('toolResult state is always output-available', () => {
    const step = makeStep(
      [{ toolCallId: 'c1', toolName: 'tool', input: {} }],
      [{ toolCallId: 'c1', toolName: 'tool', output: 'out' }],
    );
    const result = extractToolCallsFromSteps([step]);
    assert({
      given: 'a completed tool invocation',
      should: 'set the toolResult state to output-available',
      actual: result.toolResults[0]?.state,
      expected: 'output-available',
    });
  });
});
