import { describe, test } from 'vitest';
import { assert } from './riteway';
import { resolveFinishReason } from '../resolve-finish-reason';

describe('resolveFinishReason', () => {
  test('mid-loop step with tool calls returns tool_calls', () => {
    assert({
      given: 'hadToolCallInStep=true and isFinalStep=false',
      should: 'return tool_calls to signal the client to expect tool results',
      actual: resolveFinishReason(true, false),
      expected: 'tool_calls',
    });
  });

  test('final step returns stop', () => {
    assert({
      given: 'isFinalStep=true with no tool calls',
      should: 'return stop — agent is done',
      actual: resolveFinishReason(false, true),
      expected: 'stop',
    });
  });

  test('final step with tool calls returns stop', () => {
    assert({
      given: 'isFinalStep=true even when the step had tool calls',
      should: 'return stop — isFinalStep wins',
      actual: resolveFinishReason(true, true),
      expected: 'stop',
    });
  });

  test('mid-loop step without tool calls returns stop', () => {
    assert({
      given: 'hadToolCallInStep=false and isFinalStep=false',
      should: 'return stop — no tool calls means no pending work',
      actual: resolveFinishReason(false, false),
      expected: 'stop',
    });
  });
});
