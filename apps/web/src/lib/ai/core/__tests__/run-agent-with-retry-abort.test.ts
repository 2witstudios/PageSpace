// @vitest-environment node
/**
 * runAgentWithRetry on a REAL ai@6 `streamText` (MockLanguageModelV3 underneath), aborted
 * the way the chat routes abort it: the user's Stop, or the credit ceiling's controller
 * combined in with AbortSignal.any.
 *
 * What ai@6.0.212 actually does on abort, pinned here because billing reads it:
 *  - a stop during the ONLY step rejects `steps` and `totalUsage` (and onAbort gets
 *    steps: []), so the route used to settle the turn at $0;
 *  - a stop during a LATER step resolves `steps` with the finished steps but resolves
 *    `totalUsage` with no token counts at all, so even the finished steps billed $0 on
 *    a non-OpenRouter provider.
 */
import { describe, it } from 'vitest';
import { z } from 'zod';
import { streamText, stepCountIs, type ModelMessage, type Tool, type UIMessageChunk, type UIMessageStreamWriter } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { assert } from './riteway';
import { runAgentWithRetry, type AgentStreamResult } from '../run-agent-with-retry';

type DoStream = MockLanguageModelV3['doStream'];
type StreamPart =
  Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer Part> ? Part : never;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const finish = (input: number, output: number, unified: 'stop' | 'tool-calls' = 'stop'): StreamPart => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: usage(input, output),
});

const textStep = (words: number, end: StreamPart[]): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...Array.from({ length: words }, (_, k): StreamPart => ({ type: 'text-delta', id: 't', delta: `word${k} ` })),
  { type: 'text-end', id: 't' },
  ...end,
];

/**
 * A provider stream that behaves like fetch under an AbortSignal: parts arrive a few ms
 * apart, `onPart(i)` runs as part i is delivered (the test aborts from there), and once
 * the signal fires the stream errors with an AbortError.
 */
const providerStream = (
  parts: StreamPart[],
  signal: AbortSignal | undefined,
  onPart?: (index: number) => void,
): ReadableStream<StreamPart> => {
  let i = 0;
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (signal?.aborted) {
        controller.error(new DOMException('This operation was aborted', 'AbortError'));
        return;
      }
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[i]);
      onPart?.(i);
      i++;
    },
  });
};

const noopTool: Tool = { description: 'noop', inputSchema: z.object({}), execute: async () => ({ ok: true }) };
const toolCallStep: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'noop', input: '{}' },
  finish(800, 30, 'tool-calls'),
];

const baseMessages: ModelMessage[] = [{ role: 'user', content: 'summarise the quarterly report' }];

const drive = async (options: {
  model: MockLanguageModelV3;
  signal: AbortSignal;
  tools?: Record<string, Tool>;
  onStepFinish?: () => void;
  toSentMessages?: (messages: ModelMessage[]) => ModelMessage[];
}) => {
  const chunks: UIMessageChunk[] = [];
  const writer = { write: (c: UIMessageChunk) => chunks.push(c) } as unknown as UIMessageStreamWriter;
  const result = await runAgentWithRetry({
    writer,
    abortSignal: options.signal,
    baseMessages,
    toSentMessages: options.toSentMessages,
    buildStreamText: (messages) =>
      streamText({
        model: options.model,
        messages: options.toSentMessages ? options.toSentMessages(messages) : messages,
        tools: options.tools,
        stopWhen: stepCountIs(5),
        abortSignal: options.signal,
        onStepFinish: options.onStepFinish,
      }),
    finishToolName: 'finish',
    maxSteps: 5,
    startTimeMs: Date.now(),
    backoffMs: () => 0,
    logger: { info: () => {}, warn: () => {} },
  });
  const streamedText = chunks
    .filter((c): c is Extract<UIMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('');
  return { result, streamedText };
};

describe('runAgentWithRetry — abort mid-step (real ai@6 stream)', () => {
  it('records the interrupted step of a single-step turn the user stopped', async () => {
    const stop = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: providerStream(textStep(20, [finish(1000, 50)]), abortSignal, (i) => {
          if (i === 6) stop.abort();
        }),
      }),
    });

    const { result, streamedText } = await drive({ model, signal: stop.signal });

    assert({
      given: 'a user Stop while the only step is streaming',
      should: 'report no provider usage (ai@6 rejects it) but capture the prompt and exactly the output streamed',
      actual: {
        terminalReason: result.terminalReason,
        usage: result.accumulatedUsage,
        steps: result.accumulatedSteps.length,
        streamedSomething: streamedText.length > 0,
        outputText: result.abortedStep?.outputText,
        promptText: result.abortedStep?.promptText,
        priorStepContextTokens: result.abortedStep?.priorStepContextTokens,
      },
      expected: {
        terminalReason: 'aborted',
        usage: undefined,
        steps: 0,
        streamedSomething: true,
        outputText: streamedText,
        promptText: 'summarise the quarterly report',
        priorStepContextTokens: undefined,
      },
    });
  });

  it('prices the prompt the provider was SENT, including the injected turn context', async () => {
    const stop = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: providerStream(textStep(20, [finish(1000, 50)]), abortSignal, (i) => {
          if (i === 6) stop.abort();
        }),
      }),
    });
    // What the routes do: append the volatile turn context (timestamp, location,
    // mentions, command catalog) to the last user message before streamText sees it.
    const withTurnContext = (messages: ModelMessage[]): ModelMessage[] => [
      ...messages,
      { role: 'user', content: '<turn-context>it is Monday; you are on page Q3</turn-context>' },
    ];

    const { result } = await drive({ model, signal: stop.signal, toSentMessages: withTurnContext });

    assert({
      given: 'a stopped first step whose request carried an injected turn context',
      should: 'estimate the prompt from the sent messages, not the bare history',
      actual: result.abortedStep?.promptText,
      expected: 'summarise the quarterly report\n<turn-context>it is Monday; you are on page Q3</turn-context>',
    });
  });

  it('keeps the finished step AND records the interrupted one when a multi-step turn is stopped mid-step', async () => {
    const stop = new AbortController();
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call++;
        if (call === 1) return { stream: providerStream(toolCallStep, abortSignal) };
        return {
          stream: providerStream(textStep(20, [finish(900, 60)]), abortSignal, (i) => {
            if (i === 6) stop.abort();
          }),
        };
      },
    });

    const { result, streamedText } = await drive({ model, signal: stop.signal, tools: { noop: noopTool } });

    assert({
      given: 'a user Stop while step 2 streams, after step 1 (800 in / 30 out) finished',
      should: 'bill step 1 from its own usage and floor step 2\'s prompt at step 1\'s context',
      actual: {
        steps: result.accumulatedSteps.length,
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        priorStepContextTokens: result.abortedStep?.priorStepContextTokens,
        streamedSomething: streamedText.length > 0,
        outputText: result.abortedStep?.outputText,
      },
      expected: {
        steps: 1,
        inputTokens: 800,
        outputTokens: 30,
        priorStepContextTokens: 830,
        streamedSomething: true,
        outputText: streamedText,
      },
    });
  });

  it('floors the interrupted prompt without reasoning and carries the cached share', async () => {
    const stop = new AbortController();
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call++;
        if (call === 1) {
          return {
            stream: providerStream(
              [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'call-1', toolName: 'noop', input: '{}' },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  // 800 in (600 cache reads, 100 cache writes), 30 out of which 10 reasoning.
                  usage: {
                    inputTokens: { total: 800, noCache: 100, cacheRead: 600, cacheWrite: 100 },
                    outputTokens: { total: 30, text: 20, reasoning: 10 },
                  },
                },
              ],
              abortSignal,
            ),
          };
        }
        return {
          stream: providerStream(textStep(20, [finish(900, 60)]), abortSignal, (i) => {
            if (i === 6) stop.abort();
          }),
        };
      },
    });

    const { result } = await drive({ model, signal: stop.signal, tools: { noop: noopTool } });

    assert({
      given: 'step 1 reported 800 in (700 cached/written), 30 out incl. 10 reasoning; step 2 stopped',
      should: 'floor step 2 at 800 + 20 visible output and carry 700 cached tokens',
      actual: {
        priorStepContextTokens: result.abortedStep?.priorStepContextTokens,
        priorStepCachedTokens: result.abortedStep?.priorStepCachedTokens,
      },
      expected: { priorStepContextTokens: 820, priorStepCachedTokens: 700 },
    });
  });

  it('treats a credit-ceiling abort mid-step exactly like a user Stop', async () => {
    const userStop = new AbortController();
    const creditCeiling = new AbortController();
    const signal = AbortSignal.any([userStop.signal, creditCeiling.signal]);
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call++;
        if (call === 1) return { stream: providerStream(toolCallStep, abortSignal) };
        return {
          stream: providerStream(textStep(20, [finish(900, 60)]), abortSignal, (i) => {
            if (i === 4) creditCeiling.abort();
          }),
        };
      },
    });

    const { result, streamedText } = await drive({ model, signal, tools: { noop: noopTool } });

    assert({
      given: 'the credit ceiling aborting while step 2 streams',
      should: 'bill the finished step and record the interrupted one',
      actual: {
        terminalReason: result.terminalReason,
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        priorStepContextTokens: result.abortedStep?.priorStepContextTokens,
        outputText: result.abortedStep?.outputText,
      },
      expected: {
        terminalReason: 'aborted',
        inputTokens: 800,
        outputTokens: 30,
        priorStepContextTokens: 830,
        outputText: streamedText,
      },
    });
  });

  it('bills the finished steps when the credit ceiling fires at a step boundary', async () => {
    const creditCeiling = new AbortController();
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call++;
        if (call === 1) return { stream: providerStream(toolCallStep, abortSignal) };
        return { stream: providerStream(textStep(20, [finish(900, 60)]), abortSignal) };
      },
    });

    const { result } = await drive({
      model,
      signal: creditCeiling.signal,
      tools: { noop: noopTool },
      // What makeOnStepFinishHandler does when the balance is spent.
      onStepFinish: () => creditCeiling.abort(),
    });

    assert({
      given: 'the credit ceiling aborting from onStepFinish after step 1',
      should: 'bill step 1 from its own usage instead of the empty totalUsage',
      actual: {
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        abortedStep: result.abortedStep,
      },
      expected: { inputTokens: 800, outputTokens: 30, abortedStep: undefined },
    });
  });
});

describe('runAgentWithRetry — abort racing a step\'s finish', () => {
  it('does not estimate a step the SDK already recorded with provider usage', async () => {
    // The abort landed after ai@6 recorded the step (so `steps` carries its usage) but
    // before its finish-step chunk reached the UI stream — a real, narrow window.
    const stop = new AbortController();
    stop.abort();
    const chunks: UIMessageChunk[] = [];
    const writer = { write: (c: UIMessageChunk) => chunks.push(c) } as unknown as UIMessageStreamWriter;
    const recordedUsage = { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 };
    const result = await runAgentWithRetry({
      writer,
      abortSignal: stop.signal,
      baseMessages,
      buildStreamText: () =>
        ({
          toUIMessageStream: () =>
            (async function* () {
              yield { type: 'start-step' } as UIMessageChunk;
              yield { type: 'text-delta', id: 't', delta: 'the whole answer' } as UIMessageChunk;
            })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          steps: Promise.resolve([{ usage: recordedUsage }]),
          totalUsage: Promise.resolve({}),
        }) as unknown as AgentStreamResult,
      finishToolName: 'finish',
      maxSteps: 5,
      startTimeMs: Date.now(),
      backoffMs: () => 0,
      logger: { info: () => {}, warn: () => {} },
    });

    assert({
      given: 'an aborted run whose open step is already in `steps` with provider usage',
      should: 'bill that usage once and estimate nothing on top',
      actual: {
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        abortedStep: result.abortedStep,
      },
      expected: { inputTokens: 1000, outputTokens: 50, abortedStep: undefined },
    });
  });
});

describe('runAgentWithRetry — paths an abort must not change (real ai@6 stream)', () => {
  it('bills a normal completion from totalUsage with nothing interrupted', async () => {
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: providerStream(textStep(3, [finish(1000, 50)]), abortSignal),
      }),
    });

    const { result } = await drive({ model, signal: new AbortController().signal });

    assert({
      given: 'a turn that finishes on its own',
      should: 'carry the provider totals and no interrupted step',
      actual: {
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        abortedStep: result.abortedStep,
      },
      expected: { inputTokens: 1000, outputTokens: 50, abortedStep: undefined },
    });
  });

  it('bills an in-stream error chunk from totalUsage with nothing interrupted', async () => {
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: providerStream(
          textStep(3, [{ type: 'error', error: new Error('upstream 500') }, finish(1000, 50)]),
          abortSignal,
        ),
      }),
    });

    const { result } = await drive({ model, signal: new AbortController().signal });

    assert({
      given: 'a provider error chunk after content, then the provider finish',
      should: 'carry the provider totals and no interrupted step',
      actual: {
        inputTokens: result.accumulatedUsage?.inputTokens,
        outputTokens: result.accumulatedUsage?.outputTokens,
        abortedStep: result.abortedStep,
      },
      expected: { inputTokens: 1000, outputTokens: 50, abortedStep: undefined },
    });
  });
});
