import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createSideQuestionStream, type SideQuestionSettlement } from '../side-question';

// ============================================================================
// Settlement against the REAL ai SDK streamText (the version this app ships),
// driven by a mock provider. The callback order is the SDK's, not ours: an
// in-stream `error` part fires onError BEFORE the flush fires onFinish, an
// abort during the first step reports `steps: []`, and a run that produced no
// step fires neither onFinish nor onAbort (it rejects `result.steps` instead).
// Each case must bill exactly once and never at $0 when the provider did work.
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
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
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
    expect(settlements[0]).toMatchObject({ outcome: 'finished', estimated: false, usage: { inputTokens: 900, outputTokens: 100 } });
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
    expect(settlements[0]).toMatchObject({ outcome: 'errored', estimated: false, usage: { inputTokens: 900, outputTokens: 100 } });
    expect(settlements[0].error).toBeInstanceOf(Error);
    expect(settlements[0].steps).toHaveLength(1);
  });

  it('an abort after output streamed bills an estimate of the prompt and the streamed text, never $0', async () => {
    const settlements = await run(provider(head, { hang: true }), { abortAfterMs: 30 });
    expect(settlements).toHaveLength(1);
    const [settlement] = settlements;
    expect(settlement.outcome).toBe('aborted');
    expect(settlement.estimated).toBe(true);
    expect(settlement.usage.outputTokens).toBe(Math.ceil('partial answer that streamed before the end'.length / 4));
    expect(settlement.usage.inputTokens).toBeGreaterThan(Math.ceil('safe context'.length / 4));
  });

  it('an abort before any output bills nothing (no evidence the provider ran it)', async () => {
    const settlements = await run(provider(head.slice(0, 2), { hang: true }), { abortAfterMs: 30 });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'aborted', estimated: false, usage: {} });
  });

  it('a provider failure with no step (onFinish never fires) still settles once, so the hold is released', async () => {
    const settlements = await run(async () => { throw new Error('provider 500'); });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ outcome: 'errored', estimated: false, usage: {} });
    expect(settlements[0].error).toBeDefined();
  });

  it('a stream that dies after output with no step bills the estimate and settles once', async () => {
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
    expect(settlements[0]).toMatchObject({ outcome: 'errored', estimated: true });
    expect(settlements[0].usage.outputTokens).toBeGreaterThan(0);
  });
});
