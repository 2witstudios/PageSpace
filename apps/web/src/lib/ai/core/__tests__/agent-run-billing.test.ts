import { describe, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { MARKUP_BPS } from '@pagespace/lib/billing/credit-pricing';
import { assert } from './riteway';
import { agentRunBillingFields } from '../agent-run-billing';
import type { AbortedStepEstimate, RunAgentWithRetryResult } from '../run-agent-with-retry';

// $2 / $10 per million input / output tokens in the catalog.
const MODEL = 'anthropic/claude-sonnet-5';

const usage = (inputTokens: number, outputTokens: number): LanguageModelUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
  outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
});

const openRouterStep = (cost: number, id: string) => ({
  providerMetadata: { openrouter: { id, usage: { cost } } },
});

type Run = Pick<RunAgentWithRetryResult, 'accumulatedUsage' | 'accumulatedSteps' | 'abortedStep'>;

// 400 prompt chars = 100 tokens, 200 output chars = 50 tokens (estimateTokens: 4 chars/token).
const interrupted = (over: Partial<AbortedStepEstimate> = {}): AbortedStepEstimate => ({
  promptText: 'p'.repeat(400),
  outputText: 'o'.repeat(200),
  ...over,
});

const dollars = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1e9) / 1e9);

describe('agentRunBillingFields', () => {
  it('passes a run that was not aborted mid-step through on the provider numbers', () => {
    const run: Run = {
      accumulatedUsage: usage(1000, 50),
      accumulatedSteps: [openRouterStep(0.004, 'gen-1'), openRouterStep(0.006, 'gen-2')],
    };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL, promptOverheadTokens: () => 900 });

    assert({
      given: 'a finished (or errored) run with OpenRouter cost on its steps',
      should: 'bill the summed usage and OpenRouter cost, keep the reconcile ids, add nothing',
      actual: { ...fields, providerCostDollars: dollars(fields.providerCostDollars) },
      expected: {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        cachedInputTokens: undefined,
        reasoningTokens: undefined,
        providerCostDollars: 0.01,
        openrouterGenerationIds: ['gen-1', 'gen-2'],
      },
    });
  });

  it('bills the prompt plus streamed output of a single-step turn the user stopped', () => {
    const run: Run = { accumulatedUsage: undefined, accumulatedSteps: [], abortedStep: interrupted() };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL, promptOverheadTokens: () => 900 });

    assert({
      given: 'a stop during the only step: 100 message tokens + 900 system/tool tokens in, 50 streamed out',
      should: 'charge 1000 input + 50 output at the model rate instead of $0',
      actual: {
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
        providerCostDollars: dollars(fields.providerCostDollars),
        costSource: fields.costSource,
        capped: fields.abortedStep?.capped,
      },
      // 1000 * $2/M + 50 * $10/M
      expected: { inputTokens: 1000, outputTokens: 50, providerCostDollars: 0.0025, costSource: 'estimate', capped: false },
    });
  });

  it('bills the finished steps plus the interrupted one on a non-OpenRouter multi-step turn', () => {
    const run: Run = {
      accumulatedUsage: usage(800, 30),
      accumulatedSteps: [{}],
      abortedStep: interrupted({ priorStepContextTokens: 830 }),
    };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL, promptOverheadTokens: () => 900 });

    assert({
      given: 'step 1 finished at 800/30 and step 2 was stopped after streaming 50 tokens',
      should: 'charge step 1 plus step 2 priced from step 1\'s 830-token context',
      actual: {
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
        providerCostDollars: dollars(fields.providerCostDollars),
      },
      // (800*2 + 30*10)/1e6 + (830*2 + 50*10)/1e6
      expected: { inputTokens: 1630, outputTokens: 80, providerCostDollars: 0.00406 },
    });
  });

  it('prices the cached share of the interrupted prompt at the cache-read rate', () => {
    const run: Run = {
      accumulatedUsage: usage(800, 30),
      accumulatedSteps: [{}],
      abortedStep: interrupted({ priorStepContextTokens: 830, priorStepCachedTokens: 700 }),
    };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL });

    assert({
      given: 'an interrupted step whose 830-token prompt has 700 tokens the provider serves from cache',
      should: 'bill 130 fresh + 700 at the 10% cache-read rate + 50 output, and report the 700 cached',
      actual: {
        providerCostDollars: dollars(fields.providerCostDollars),
        cachedInputTokens: fields.cachedInputTokens,
        stepCachedInputTokens: fields.abortedStep?.cachedInputTokens,
      },
      // step 1: (800*2 + 30*10)/1e6 = 0.0019; step 2: (130*2 + 700*2*0.1 + 50*10)/1e6 = 0.0009
      expected: { providerCostDollars: 0.0028, cachedInputTokens: 700, stepCachedInputTokens: 700 },
    });
  });

  it('reports finished-step and interrupted-step cache reads together', () => {
    const run: Run = {
      accumulatedUsage: { ...usage(800, 30), cachedInputTokens: 600 },
      accumulatedSteps: [{}],
      abortedStep: interrupted({ priorStepContextTokens: 830, priorStepCachedTokens: 700 }),
    };
    const uncached: Run = {
      accumulatedUsage: usage(800, 30),
      accumulatedSteps: [{}],
      abortedStep: interrupted({ priorStepContextTokens: 830 }),
    };

    assert({
      given: 'step 1 read 600 tokens from cache and the interrupted step 700, vs a run with no cache data',
      should: 'report 600 + 700 for the first, and leave the second undefined',
      actual: {
        cached: agentRunBillingFields({ agentRun: run, model: MODEL }).cachedInputTokens,
        uncached: agentRunBillingFields({ agentRun: uncached, model: MODEL }).cachedInputTokens,
      },
      expected: { cached: 1300, uncached: undefined },
    });
  });

  it('adds the interrupted step on top of OpenRouter\'s returned cost and keeps it out of the reconcile', () => {
    const run: Run = {
      accumulatedUsage: usage(800, 30),
      accumulatedSteps: [openRouterStep(0.01, 'gen-1')],
      abortedStep: interrupted({ priorStepContextTokens: 830 }),
    };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL });

    assert({
      given: 'an OpenRouter turn whose finished step cost $0.01, stopped mid-step 2',
      should: 'bill $0.01 + the interrupted step, and withhold the ids the reconcile would use to refund it',
      actual: {
        providerCostDollars: dollars(fields.providerCostDollars),
        openrouterGenerationIds: fields.openrouterGenerationIds,
        keptIds: fields.abortedStep?.generationIds,
      },
      expected: { providerCostDollars: 0.01216, openrouterGenerationIds: [], keptIds: ['gen-1'] },
    });
  });

  it('never charges more for the interrupted step than the hold reserved for the call', () => {
    const run: Run = {
      accumulatedUsage: undefined,
      accumulatedSteps: [],
      abortedStep: interrupted({ outputText: 'o'.repeat(4_000_000) }),
    };

    const fields = agentRunBillingFields({ agentRun: run, model: MODEL });
    const holdDollars = estimateChatHoldCentsForModel(MODEL) / 100 / (MARKUP_BPS / 10000);

    assert({
      given: 'an estimate (1M output tokens, $10) far above the chat hold',
      should: 'cap the interrupted step at the hold',
      actual: { providerCostDollars: dollars(fields.providerCostDollars), capped: fields.abortedStep?.capped },
      expected: { providerCostDollars: dollars(holdDollars), capped: true },
    });
  });
});
