import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI, type GateOptions } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { CREDIT_HOLD_ESTIMATE_CENTS, MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { resolveSteps, hasAiStep, countAiSteps } from './core/step-plan';
import type { RunAdmission, WorkflowExecutionInput } from './workflow-executor';

/**
 * How a run was started, which decides the gate's caps:
 *   - interactive: a user pressed Run. Same bounds as chat — the per-user/day
 *     exposure cap applies and the in-flight cap stops a click-storm fan-out.
 *   - scheduled: a cron fired it. Like the calendar/zoom trigger executors, the
 *     interactive daily backstop does not apply (one fire per schedule tick).
 */
type WorkflowRunMode = 'interactive' | 'scheduled';

type WorkflowCreditHold =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: GateReason };

/** The parts of a run's input the gate reads: who is billed, and what will run. */
type GatedRunInput = Pick<WorkflowExecutionInput, 'createdBy' | 'steps' | 'prompt' | 'agentPageId'>;

/** The run error for a denied gate — the same text the trigger executors return. */
export const creditDeniedError = (reason: GateReason): string => `AI credit gate denied: ${reason}`;

const NO_HOLD: WorkflowCreditHold = { allowed: true, release: () => {} };

/**
 * Credit gate for a workflow run, taken BEFORE executeWorkflow builds a model.
 * It reads the same input the executor will run, so the gated user is the
 * billed user (executeWorkflow tracks usage as `createdBy`) and the reservation
 * is sized from the steps that will actually execute. Callers pass it to the
 * executor through `creditAdmission` rather than calling it before the run.
 * executeWorkflow debits real usage itself (AIMonitoring.trackUsage →
 * consumeCredits, no holdId), so the hold only reserves headroom while the run
 * is in flight: the caller must call `release` once the run settles, in a
 * `finally`. `release` is idempotent — the hold is freed exactly once.
 *
 * One hold covers the whole run, sized by its ai-step count (a step chain bills
 * once per ai step). A deterministic-only chain runs no model: no gate, no hold.
 */
export async function acquireWorkflowCreditHold(
  input: GatedRunInput,
  mode: WorkflowRunMode,
): Promise<WorkflowCreditHold> {
  const userId = input.createdBy;
  const steps = resolveSteps({ steps: input.steps ?? null, prompt: input.prompt, agentPageId: input.agentPageId });
  if (!hasAiStep(steps)) return NO_HOLD;

  const [user] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId));

  const estCostCents = CREDIT_HOLD_ESTIMATE_CENTS * countAiSteps(steps);
  const opts: GateOptions = mode === 'interactive'
    ? { estCostCents, maxInFlight: MAX_CHAT_INFLIGHT }
    : { estCostCents, skipDailyCap: true };

  const gate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, opts);
  if (!gate.allowed) return { allowed: false, reason: gate.reason };

  const holdId = gate.holdId;
  if (!holdId) return NO_HOLD;

  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      void releaseHold(holdId).catch(() => {});
    },
  };
}

/**
 * The credit gate as executeWorkflow's `admit` hook, so it runs INSIDE the
 * run's atomic claim: an overlapping fire of the same workflow loses the claim
 * and never gates, and a refused fire is finalized by the executor as a
 * `cancelled` run whose error names the reason (a skip, not a failure). The
 * executor calls `release` exactly once when an admitted run settles.
 * `onDenied` hands the raw gate reason to a caller that maps it (the manual
 * Run route's 402/429).
 */
export function creditAdmission(
  input: GatedRunInput,
  mode: WorkflowRunMode,
  onDenied?: (reason: GateReason) => void,
): () => Promise<RunAdmission> {
  return async () => {
    const hold = await acquireWorkflowCreditHold(input, mode);
    if (hold.allowed) return { admitted: true, release: hold.release };
    onDenied?.(hold.reason);
    return { admitted: false, error: creditDeniedError(hold.reason) };
  };
}
