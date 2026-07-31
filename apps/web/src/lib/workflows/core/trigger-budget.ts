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
  /** Per-webhook channel-post limit also applies (a send_channel_message step exists). */
  channelLimit: boolean;
};

export function selectTriggerBudgets(steps: readonly WorkflowStep[]): TriggerBudgetPlan {
  const ai = hasAiStep(steps);
  const channelLimit = steps.some(
    (step) => step.kind === 'tool' && step.toolName === 'send_channel_message'
  );
  return {
    aiBudget: ai,
    creditHold: ai,
    deterministicBudget: !ai,
    channelLimit,
  };
}
