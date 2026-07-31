/**
 * Pure budget/limit selection for a workflow's step mix. The webhook shell
 * maps these flags onto the concrete distributed rate limits
 * (PAGE_WEBHOOK_AI_BUDGET, PAGE_WEBHOOK_DETERMINISTIC_BUDGET, the per-webhook
 * channel-post limit) and the canConsumeAI credit hold.
 */

import type { WorkflowStep } from '@pagespace/db/schema/workflows';
import { hasAiStep } from './step-plan';

export type TriggerBudgetPlan = {
  /** Per-webhook AI budget applies (any ai step present). */
  aiBudget: boolean;
  /** canConsumeAI credit hold must be taken (any ai step present). */
  creditHold: boolean;
  /** Cheaper deterministic budget applies (all-tool chains only). */
  deterministicBudget: boolean;
  /**
   * Number of send_channel_message steps in the chain. The shared per-webhook
   * channel-post bucket must be charged this many tokens, not one flat charge
   * per run — a chain can post this many messages in a single fire, and the
   * bucket's whole purpose is bounding posts, not runs.
   */
  channelPostCount: number;
};

export function selectTriggerBudgets(steps: readonly WorkflowStep[]): TriggerBudgetPlan {
  const ai = hasAiStep(steps);
  const channelPostCount = steps.filter(
    (step) => step.kind === 'tool' && step.toolName === 'send_channel_message'
  ).length;
  return {
    aiBudget: ai,
    creditHold: ai,
    deterministicBudget: !ai,
    channelPostCount,
  };
}
