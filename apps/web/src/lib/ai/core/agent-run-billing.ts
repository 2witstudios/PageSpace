import {
  calculateCost,
  estimateTokens,
  extractOpenRouterCostDollars,
  extractOpenRouterGenerationIds,
} from '@pagespace/lib/monitoring/ai-monitoring';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { MARKUP_BPS } from '@pagespace/lib/billing/credit-pricing';
import type { RunAgentWithRetryResult } from './run-agent-with-retry';

/** How the step that was still streaming at an abort was priced. Stamped into usage metadata. */
export interface AbortedStepBilling {
  inputTokens: number;
  outputTokens: number;
  /** Real (pre-markup) cost added for the interrupted step. */
  costDollars: number;
  /** True when the estimate exceeded the chat hold and was cut down to it. */
  capped: boolean;
  /**
   * Generation ids of the FINISHED steps. Kept here instead of on the row's reconcile
   * list: the cost reconcile fetches only these generations and would refund the
   * interrupted step's charge, whose generation id the stream never delivered.
   */
  generationIds: string[];
}

/** The usage/cost fields of `AIMonitoring.trackUsage` for one agent run. */
export interface AgentRunBillingFields {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  cachedInputTokens: number | undefined;
  reasoningTokens: number | undefined;
  providerCostDollars: number | undefined;
  openrouterGenerationIds: string[];
  costSource?: 'estimate';
  abortedStep?: AbortedStepBilling;
}

/**
 * What to bill for an agent run. For a run that finished (or errored) on its own this
 * is exactly the provider's numbers: summed usage and OpenRouter's returned cost.
 *
 * For a run aborted mid-step (user Stop, credit ceiling) it adds the interrupted step,
 * which the provider has already charged us for but ai@6 reports no usage for: its
 * prompt (the prior finished step's reported context when there is one, else the
 * estimated messages + system prompt + tools) plus the output actually streamed before
 * the abort, counted with `estimateTokens` and priced at the model's catalog rate. The
 * addition never exceeds the chat hold the credit gate reserved for the call, so a
 * wrong estimate is bounded by what the user was already told could be spent.
 */
export function agentRunBillingFields(params: {
  agentRun: Pick<RunAgentWithRetryResult, 'accumulatedUsage' | 'accumulatedSteps' | 'abortedStep'> | undefined;
  model: string;
  /**
   * Estimated tokens of the system prompt and tool definitions sent with every step.
   * A thunk because it is only needed when a step was interrupted.
   */
  promptOverheadTokens?: () => number;
}): AgentRunBillingFields {
  const { agentRun, model, promptOverheadTokens = () => 0 } = params;
  const usage = agentRun?.accumulatedUsage;
  const steps = agentRun?.accumulatedSteps;
  const inputTokens = usage?.inputTokens ?? undefined;
  const outputTokens = usage?.outputTokens ?? undefined;
  const cachedInputTokens = usage?.cachedInputTokens;
  const reasoningTokens = usage?.reasoningTokens;
  const providerCostDollars = extractOpenRouterCostDollars(steps);
  const openrouterGenerationIds = extractOpenRouterGenerationIds(steps);

  const aborted = agentRun?.abortedStep;
  if (!aborted) {
    return {
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens ?? ((usage?.inputTokens || 0) + (usage?.outputTokens || 0) || undefined),
      cachedInputTokens,
      reasoningTokens,
      providerCostDollars,
      openrouterGenerationIds,
    };
  }

  const stepInputTokens =
    aborted.priorStepContextTokens ?? estimateTokens(aborted.promptText) + promptOverheadTokens();
  const stepOutputTokens = estimateTokens(aborted.outputText);
  const estimatedDollars = calculateCost(model, stepInputTokens, stepOutputTokens);
  const capDollars = estimateChatHoldCentsForModel(model) / 100 / (MARKUP_BPS / 10000);
  const stepDollars = Math.min(estimatedDollars, capDollars);

  const finishedStepsDollars =
    providerCostDollars ??
    calculateCost(model, inputTokens, outputTokens, { cachedInputTokens, reasoningTokens });

  const billedInput = (inputTokens ?? 0) + stepInputTokens;
  const billedOutput = (outputTokens ?? 0) + stepOutputTokens;
  return {
    inputTokens: billedInput,
    outputTokens: billedOutput,
    totalTokens: billedInput + billedOutput,
    cachedInputTokens,
    reasoningTokens,
    providerCostDollars: finishedStepsDollars + stepDollars,
    openrouterGenerationIds: [],
    costSource: 'estimate',
    abortedStep: {
      inputTokens: stepInputTokens,
      outputTokens: stepOutputTokens,
      costDollars: stepDollars,
      capped: estimatedDollars > capDollars,
      generationIds: openrouterGenerationIds,
    },
  };
}
