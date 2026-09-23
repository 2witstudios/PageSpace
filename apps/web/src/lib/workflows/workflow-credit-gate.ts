import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { CREDIT_HOLD_ESTIMATE_CENTS, MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import type { DeniedGateReason } from '@pagespace/lib/billing/classify-gate-refusal';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';
import { resolveSteps, countAiSteps } from './core/step-plan';
import { workflowGateOptions, type WorkflowGatePolicy } from './core/workflow-gate-options';

type WorkflowCreditDecision =
  | { allowed: true; holdId?: string }
  | { allowed: false; reason: DeniedGateReason };

export interface WorkflowCreditInput {
  createdBy: string;
  agentPageId: string | null;
  prompt: string;
  steps?: WorkflowStep[] | null;
  source: { table: string };
  creditGate?: WorkflowGatePolicy;
}

/**
 * Gate a workflow run on the billed user's credit (`createdBy`) and reserve a
 * hold sized for every ai step. Runs INSIDE executeWorkflow, after the run's
 * atomic claim and before any model is built, so no entry point can skip it
 * and only the fire holding the claim is gated; the executor releases the
 * returned hold when the run ends.
 * An unclaimed agent is refused here (`requires_funding`) exactly as every
 * other AI surface refuses it.
 */
export async function acquireWorkflowCredit(input: WorkflowCreditInput): Promise<WorkflowCreditDecision> {
  const steps = resolveSteps({
    steps: input.steps ?? null,
    prompt: input.prompt,
    agentPageId: input.agentPageId,
  });
  const opts = workflowGateOptions({
    sourceTable: input.source.table,
    aiStepCount: countAiSteps(steps),
    policy: input.creditGate,
    holdEstimateCents: CREDIT_HOLD_ESTIMATE_CENTS,
    maxInteractiveInFlight: MAX_CHAT_INFLIGHT,
  });
  if (opts === null) return { allowed: true };

  const [owner] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, input.createdBy));
  const gate = await canConsumeAI(
    input.createdBy,
    (owner?.subscriptionTier ?? 'free') as SubscriptionTier,
    opts,
  );
  if (!gate.allowed) return { allowed: false, reason: gate.reason as DeniedGateReason };
  return { allowed: true, holdId: gate.holdId };
}
