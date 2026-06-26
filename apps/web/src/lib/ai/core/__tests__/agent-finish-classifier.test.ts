import { describe, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { assert } from './riteway';
import {
  classifyAttempt,
  calledFinishTool,
  type ClassifyAttemptArgs,
} from '../agent-finish-classifier';

const FINISH = 'finish';

const assistantText = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

const assistantToolCall = (toolName: string, toolCallId = 'c1'): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
});

const base = (over: Partial<ClassifyAttemptArgs>): ClassifyAttemptArgs => ({
  finishReason: 'stop',
  caughtError: undefined,
  responseMessages: [],
  stepCount: 1,
  maxSteps: 100,
  finishToolName: FINISH,
  aborted: false,
  emittedContent: false,
  ...over,
});

describe('calledFinishTool', () => {
  it('detects the finish tool among parallel tool calls', () => {
    assert({
      given: 'an assistant turn calling the finish tool alongside another tool',
      should: 'return true',
      actual: calledFinishTool(
        [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'a', toolName: 'search', input: {} },
              { type: 'tool-call', toolCallId: 'b', toolName: FINISH, input: {} },
            ],
          },
        ],
        FINISH,
      ),
      expected: true,
    });
  });

  it('returns false when no finish tool call is present', () => {
    assert({
      given: 'an assistant turn calling only a non-finish tool',
      should: 'return false',
      actual: calledFinishTool([assistantToolCall('search')], FINISH),
      expected: false,
    });
  });
});

describe('classifyAttempt', () => {
  it('aborted is always terminal, even with a retryable error', () => {
    assert({
      given: 'a user abort during a provider error',
      should: 'be terminal:aborted (never retry a user stop)',
      actual: classifyAttempt(base({ aborted: true, caughtError: new Error('boom') })),
      expected: { kind: 'terminal', reason: 'aborted' },
    });
  });

  it('a thrown stream error with NO content streamed is retryable', () => {
    assert({
      given: 'an exception caught before any content reached the client',
      should: 'retry as provider-error (safe — nothing to duplicate)',
      actual: classifyAttempt(
        base({ caughtError: new Error('disconnected'), finishReason: undefined, emittedContent: false }),
      ),
      expected: { kind: 'retry', reason: 'provider-error' },
    });
  });

  it('a thrown stream error AFTER content was streamed is terminal (no duplication)', () => {
    assert({
      given: 'a mid-stream drop after partial content already reached the client',
      should: 'be terminal:provider-error (a from-scratch retry would duplicate / re-run tools)',
      actual: classifyAttempt(
        base({ caughtError: new Error('disconnected'), finishReason: undefined, emittedContent: true }),
      ),
      expected: { kind: 'terminal', reason: 'provider-error' },
    });
  });

  it('finishReason error with no content streamed is retryable', () => {
    assert({
      given: 'a provider error finish before any content',
      should: 'retry as provider-error',
      actual: classifyAttempt(base({ finishReason: 'error', emittedContent: false })),
      expected: { kind: 'retry', reason: 'provider-error' },
    });
  });

  it('finishReason stop is clean', () => {
    assert({
      given: 'a natural stop with final text',
      should: 'be clean',
      actual: classifyAttempt(base({ finishReason: 'stop', responseMessages: [assistantText('done')] })),
      expected: { kind: 'clean' },
    });
  });

  it('tool-calls ending with the finish tool is clean', () => {
    assert({
      given: 'a tool-calls finish where the finish tool was called',
      should: 'be clean',
      actual: classifyAttempt(
        base({ finishReason: 'tool-calls', responseMessages: [assistantToolCall(FINISH)] }),
      ),
      expected: { kind: 'clean' },
    });
  });

  it('tool-calls without finish at the step cap is terminal:step-budget', () => {
    assert({
      given: 'a tool-calls finish with no finish tool and step budget exhausted',
      should: 'be terminal:step-budget (retry would not help)',
      actual: classifyAttempt(
        base({
          finishReason: 'tool-calls',
          responseMessages: [assistantToolCall('search')],
          stepCount: 100,
          maxSteps: 100,
        }),
      ),
      expected: { kind: 'terminal', reason: 'step-budget' },
    });
  });

  it('tool-calls without finish below the cap is terminal (anomalous, not retried)', () => {
    assert({
      given: 'a tool-calls finish with no finish tool, budget left (unreachable under normal stopWhen)',
      should: 'be terminal:tool-calls-no-finish — the SDK auto-continues tool steps, so a retry cannot help',
      actual: classifyAttempt(
        base({
          finishReason: 'tool-calls',
          responseMessages: [assistantToolCall('search')],
          stepCount: 12,
          maxSteps: 100,
        }),
      ),
      expected: { kind: 'terminal', reason: 'tool-calls-no-finish' },
    });
  });

  it('length is terminal (truncation repeats)', () => {
    assert({
      given: 'an output token cap',
      should: 'be terminal:length',
      actual: classifyAttempt(base({ finishReason: 'length' })),
      expected: { kind: 'terminal', reason: 'length' },
    });
  });

  it('content-filter is terminal (deterministic)', () => {
    assert({
      given: 'a content filter stop',
      should: 'be terminal:content-filter',
      actual: classifyAttempt(base({ finishReason: 'content-filter' })),
      expected: { kind: 'terminal', reason: 'content-filter' },
    });
  });

  it('other finish reasons with no content are ambiguous retries', () => {
    assert({
      given: "an 'other' finishReason before any content",
      should: 'retry as ambiguous',
      actual: classifyAttempt(base({ finishReason: 'other', emittedContent: false })),
      expected: { kind: 'retry', reason: 'ambiguous' },
    });
  });

  it('other finish reasons AFTER content are terminal', () => {
    assert({
      given: "an 'other' finishReason after content was streamed",
      should: 'be terminal:ambiguous (restarting would duplicate)',
      actual: classifyAttempt(base({ finishReason: 'other', emittedContent: true })),
      expected: { kind: 'terminal', reason: 'ambiguous' },
    });
  });
});
