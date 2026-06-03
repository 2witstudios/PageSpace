import { describe, it } from 'vitest';
import type { FinishReason, ModelMessage, UIMessageChunk, UIMessageStreamWriter } from 'ai';
import { assert } from './riteway';
import { runAgentWithRetry, type AgentStreamResult } from '../run-agent-with-retry';

interface FakeAttempt {
  finishReason: FinishReason;
  responseMessages?: ModelMessage[];
  steps?: unknown[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  throwOnPipe?: boolean;
}

const fakeResult = (a: FakeAttempt): AgentStreamResult =>
  ({
    toUIMessageStream: () =>
      (async function* () {
        if (a.throwOnPipe) throw new Error('provider disconnected');
        yield { type: 'text-delta', id: 't', delta: 'hello' } as unknown as UIMessageChunk;
      })(),
    finishReason: Promise.resolve(a.finishReason),
    response: Promise.resolve({ messages: a.responseMessages ?? [] }),
    steps: Promise.resolve(a.steps ?? [{}]),
    totalUsage: Promise.resolve(a.usage ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

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
    buildStreamText: () => fakeResult(attempts[Math.min(i++, attempts.length - 1)]),
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
