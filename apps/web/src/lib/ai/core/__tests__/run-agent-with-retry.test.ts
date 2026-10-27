import { describe, it } from 'vitest';
import type { FinishReason, ModelMessage, UIMessageChunk, UIMessageStreamWriter } from 'ai';
import { assert } from './riteway';
import { runAgentWithRetry, isRunAborted, type AgentStreamResult } from '../run-agent-with-retry';

interface FakeAttempt {
  finishReason: FinishReason;
  responseMessages?: ModelMessage[];
  steps?: unknown[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Throw immediately, before any content chunk (pre-content provider failure). */
  throwOnPipe?: boolean;
  /** Emit a content chunk, THEN throw (mid-stream drop after content). */
  throwAfterContent?: boolean;
  /** Emit no content at all (e.g. a clean-but-empty finish). */
  noContent?: boolean;
  /** buildStreamText throws synchronously for this attempt (bad config / factory failure). */
  throwSync?: boolean;
}

const fakeResult = (a: FakeAttempt): AgentStreamResult =>
  ({
    toUIMessageStream: () =>
      (async function* () {
        if (a.throwOnPipe) throw new Error('provider disconnected');
        if (!a.noContent) {
          yield { type: 'text-delta', id: 't', delta: 'hello' } as unknown as UIMessageChunk;
        }
        if (a.throwAfterContent) throw new Error('provider disconnected mid-stream');
      })(),
    finishReason: Promise.resolve(a.finishReason),
    response: Promise.resolve({ messages: a.responseMessages ?? [] }),
    steps: Promise.resolve(a.steps ?? [{}]),
    totalUsage: Promise.resolve(a.usage ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
  }) as unknown as AgentStreamResult;

const makeWriter = () => {
  const chunks: UIMessageChunk[] = [];
  const writer = { write: (c: UIMessageChunk) => chunks.push(c) } as unknown as UIMessageStreamWriter;
  return { writer, chunks };
};

const noopLogger = { info: () => {}, warn: () => {} };

const run = (attempts: FakeAttempt[], maxRetries = 2) => {
  const { writer, chunks } = makeWriter();
  let i = 0;
  return runAgentWithRetry({
    writer,
    abortSignal: new AbortController().signal,
    baseMessages: [{ role: 'user', content: 'hi' }],
    buildStreamText: () => {
      const a = attempts[Math.min(i++, attempts.length - 1)];
      if (a.throwSync) throw new Error('synchronous factory failure');
      return fakeResult(a);
    },
    finishToolName: 'finish',
    maxSteps: 100,
    maxRetries,
    startTimeMs: 0,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
    backoffMs: () => 0,
    logger: noopLogger,
  }).then((result) => ({ result, chunks }));
};

describe('runAgentWithRetry', () => {
  it('retries a provider error then succeeds', async () => {
    const { result } = await run([
      { finishReason: 'error', throwOnPipe: true, steps: [{}] },
      { finishReason: 'stop', responseMessages: [{ role: 'assistant', content: 'done' }], steps: [{}, {}] },
    ]);
    assert({
      given: 'attempt 1 errors and attempt 2 finishes cleanly',
      should: 'run 2 attempts, end clean, and accumulate steps across both',
      actual: {
        attempts: result.attempts,
        finalOutcome: result.finalOutcome,
        stepCount: result.accumulatedSteps.length,
      },
      expected: { attempts: 2, finalOutcome: 'clean', stepCount: 3 },
    });
  });

  it('catches a synchronous buildStreamText throw and retries under one envelope', async () => {
    const { result, chunks } = await run([
      { finishReason: 'error', throwSync: true },
      { finishReason: 'stop' },
    ]);
    assert({
      given: 'the streamText factory throws synchronously on the first attempt',
      should: 'catch it, retry, finish cleanly, and keep a single start/finish envelope',
      actual: {
        attempts: result.attempts,
        finalOutcome: result.finalOutcome,
        starts: chunks.filter((c) => c.type === 'start').length,
        finishes: chunks.filter((c) => c.type === 'finish').length,
      },
      expected: { attempts: 2, finalOutcome: 'clean', starts: 1, finishes: 1 },
    });
  });

  it('caps retries and surfaces a terminal error when always failing', async () => {
    const { result, chunks } = await run([{ finishReason: 'error', throwOnPipe: true }]);
    assert({
      given: 'every attempt throws a provider error',
      should: 'cap at maxRetries+1 attempts, end exhausted, and write one terminal error chunk',
      actual: {
        attempts: result.attempts,
        finalOutcome: result.finalOutcome,
        errorChunks: chunks.filter((c) => c.type === 'error').length,
      },
      expected: { attempts: 3, finalOutcome: 'exhausted', errorChunks: 1 },
    });
  });

  it('does NOT retry a provider error that occurred after content was streamed', async () => {
    const { result, chunks } = await run([
      { finishReason: 'error', throwAfterContent: true },
      { finishReason: 'stop' },
    ]);
    assert({
      given: 'attempt 1 streams content then drops mid-stream',
      should: 'stop after one attempt (no duplication) and surface a terminal error',
      actual: {
        attempts: result.attempts,
        finalOutcome: result.finalOutcome,
        reason: result.terminalReason,
        errorChunks: chunks.filter((c) => c.type === 'error').length,
      },
      expected: { attempts: 1, finalOutcome: 'terminal', reason: 'provider-error', errorChunks: 1 },
    });
  });

  it('surfaces a terminal error when ambiguous retries are exhausted (empty result)', async () => {
    const { result, chunks } = await run([{ finishReason: 'other', noContent: true }]);
    assert({
      given: 'every attempt ends ambiguous with no content streamed',
      should: 'exhaust retries and surface one terminal error (no silent empty message)',
      actual: {
        finalOutcome: result.finalOutcome,
        errorChunks: chunks.filter((c) => c.type === 'error').length,
      },
      expected: { finalOutcome: 'exhausted', errorChunks: 1 },
    });
  });

  it('never retries a terminal length finish', async () => {
    const { result } = await run([{ finishReason: 'length' }]);
    assert({
      given: 'a length-capped first attempt',
      should: 'run exactly one attempt and end terminal',
      actual: { attempts: result.attempts, finalOutcome: result.finalOutcome, reason: result.terminalReason },
      expected: { attempts: 1, finalOutcome: 'terminal', reason: 'length' },
    });
  });

  it('wraps all attempts in exactly one start/finish envelope', async () => {
    const { chunks } = await run([
      { finishReason: 'error', throwOnPipe: true },
      { finishReason: 'stop' },
    ]);
    assert({
      given: 'a run that retries once',
      should: 'emit a single start and a single finish around both attempts',
      actual: {
        starts: chunks.filter((c) => c.type === 'start').length,
        finishes: chunks.filter((c) => c.type === 'finish').length,
      },
      expected: { starts: 1, finishes: 1 },
    });
  });
});

describe('isRunAborted', () => {
  const abortSignal = (aborted: boolean): AbortSignal => {
    const ac = new AbortController();
    if (aborted) ac.abort();
    return ac.signal;
  };

  it('given terminalReason is aborted, should return true regardless of the live signal', async () => {
    assert({
      given: "agentRun.terminalReason === 'aborted', abortSignal not (yet) aborted",
      should: 'return true',
      actual: isRunAborted({ agentRun: { terminalReason: 'aborted' }, abortSignal: abortSignal(false) }),
      expected: true,
    });
  });

  it('given the live abortSignal is aborted, should return true regardless of terminalReason', async () => {
    assert({
      given: 'abortSignal.aborted === true, agentRun.terminalReason undefined',
      should: 'return true',
      actual: isRunAborted({ agentRun: undefined, abortSignal: abortSignal(true) }),
      expected: true,
    });
  });

  it('given neither is aborted, should return false', async () => {
    assert({
      given: 'a clean run: no terminalReason, signal not aborted',
      should: 'return false',
      actual: isRunAborted({ agentRun: { terminalReason: undefined }, abortSignal: abortSignal(false) }),
      expected: false,
    });
  });

  it('given a non-aborted terminalReason (e.g. exhausted retry) and a live non-aborted signal, should return false', async () => {
    assert({
      given: "agentRun.terminalReason === 'exhausted', abortSignal not aborted",
      should: 'return false — an exhausted retry is not the same as a user/gate abort',
      actual: isRunAborted({ agentRun: { terminalReason: 'exhausted' }, abortSignal: abortSignal(false) }),
      expected: false,
    });
  });
});
