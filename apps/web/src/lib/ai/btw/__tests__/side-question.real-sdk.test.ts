import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createSideQuestionStream, type SideQuestionSettlement } from '../side-question';

// ============================================================================
// Settlement against the REAL ai SDK streamText (the version this app ships),
// driven by a mock provider. The callback order is the SDK's, not ours: an
// in-stream `error` part fires onError BEFORE the flush fires onFinish, an
// abort during the first step reports `steps: []`, and a run that produced no
// step fires neither onFinish nor onAbort (it rejects `result.steps` instead).
// Each case must settle exactly once; an abort must carry the interrupted step
// (prompt + streamed output) so the route can bill it rather than $0.
// ============================================================================

type DoStream = MockLanguageModelV3['doStream'];
type StreamPart = Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

const head: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'resp-1', modelId: 'mock', timestamp: new Date(0) },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'partial answer that streamed before the end' },
];
const finish: StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: USAGE,
  providerMetadata: { openrouter: { id: 'gen-1', usage: { cost: 0.0042 } } },
};

/** A provider that emits `parts`, then either closes or hangs until the call's abort signal fires. */
const provider = (parts: StreamPart[], { hang = false } = {}): DoStream => async (options) => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      if (!hang) {
        controller.close();
        return;
      }
      options.abortSignal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  }),
});

/** Run one side question through the real SDK and collect every settlement. */
async function run(doStream: DoStream, { abortAfterMs }: { abortAfterMs?: number } = {}) {
  const settlements: SideQuestionSettlement[] = [];
  const controller = new AbortController();
  const response = createSideQuestionStream({
    model: new MockLanguageModelV3({ doStream }),
    question: 'What changed?',
    snapshot: 'safe context',
    abortSignal: controller.signal,
    onSettle: async (settlement) => { settlements.push(settlement); },
  });
  if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
  await response.text().catch(() => '');
  // Let the SDK's trailing promise work (flush, rejected `steps`) run out.
  await vi.waitFor(() => expect(settlements.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return settlements;
}

describe('side-question settlement against the real ai SDK', () => {
  it('a clean run settles once, finished, with the provider usage and cost metadata', async () => {
    const settlements = await run(provider([...head, { type: 'text-end', id: 't1' }, finish]));
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'finished', usage: { inputTokens: 900, outputTokens: 100 } });
    expect(settlements[0].interruptedStep).toBeUndefined();
    expect(settlements[0].steps).toHaveLength(1);
  });

  it('an in-stream error part does not settle at $0 ahead of onFinish: the real usage is billed, once', async () => {
    const settlements = await run(provider([
      ...head,
      { type: 'error', error: new Error('upstream hiccup') },
      { type: 'text-end', id: 't1' },
      finish,
    ]));
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'errored', usage: { inputTokens: 900, outputTokens: 100 } });
    expect(settlements[0].interruptedStep).toBeUndefined();
    expect(settlements[0].error).toBeInstanceOf(Error);
    expect(settlements[0].steps).toHaveLength(1);
  });

  it('an abort mid-answer reports no provider usage (steps: []) and carries the interrupted step: the prompt and exactly what streamed', async () => {
    const settlements = await run(provider(head, { hang: true }), { abortAfterMs: 30 });
    expect(settlements).toHaveLength(1);
    const [settlement] = settlements;
    expect(settlement).toMatchObject({ outcome: 'aborted', usage: {}, steps: [] });
    expect(settlement.interruptedStep?.outputText).toBe('partial answer that streamed before the end');
    expect(settlement.interruptedStep?.promptText).toContain('<conversation_snapshot>\nsafe context\n</conversation_snapshot>');
    expect(settlement.interruptedStep?.promptText).toContain('detached side question');
  });

  it('an abort before any output still carries the interrupted step (the provider read the prompt)', async () => {
    const settlements = await run(provider(head.slice(0, 2), { hang: true }), { abortAfterMs: 30 });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'aborted', usage: {}, interruptedStep: { outputText: '' } });
  });

  it('a provider failure with no step (onFinish never fires) still settles once, so the hold is released', async () => {
    const settlements = await run(async () => { throw new Error('provider 500'); });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'errored', usage: {} });
    expect(settlements[0].interruptedStep).toBeUndefined();
    expect(settlements[0].error).toBeDefined();
  });

  // Not an abort, so not the interrupted-step policy: like the chat route, a
  // provider-side failure bills what the provider reported (here, nothing).
  it('a stream that dies after output with no step settles once, as an error with no interrupted step', async () => {
    const dying: DoStream = async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of head) controller.enqueue(part);
          // Fail only after the queued parts were read (error() discards a queue).
          setTimeout(() => controller.error(new Error('connection reset')), 20);
        },
      }),
    });
    const settlements = await run(dying);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'errored', usage: {} });
    expect(settlements[0].interruptedStep).toBeUndefined();
  });
});
