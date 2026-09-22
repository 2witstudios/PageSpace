import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { canConsumeAI, type GateOptions } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { CREDIT_HOLD_ESTIMATE_CENTS, MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { resolveSteps, hasAiStep, countAiSteps } from './core/step-plan';
import type { WorkflowRunSource } from './workflow-executor';

/**
 * How a run was started, which decides the gate's caps:
 *   - interactive: a user pressed Run. Same bounds as chat — the per-user/day
 *     exposure cap applies and the in-flight cap stops a click-storm fan-out.
 *   - scheduled: a cron fired it. Like the calendar/zoom trigger executors, the
 *     interactive daily backstop does not apply (one fire per schedule tick).
 */
export type WorkflowRunMode = 'interactive' | 'scheduled';

export type WorkflowCreditHold =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: GateReason };

type WorkflowStepSource = {
  steps: WorkflowStep[] | null;
  prompt: string;
  agentPageId: string | null;
};

/** The run error for a denied gate — the same text the trigger executors return. */
export const creditDeniedError = (reason: GateReason): string => `AI credit gate denied: ${reason}`;

const NO_HOLD: WorkflowCreditHold = { allowed: true, release: () => {} };

/**
 * Credit gate for a workflow run, taken BEFORE executeWorkflow builds a model.
 * executeWorkflow debits real usage itself (AIMonitoring.trackUsage →
 * consumeCredits, no holdId), so the hold only reserves headroom while the run
 * is in flight: the caller must call `release` once the run settles, in a
 * `finally`. `release` is idempotent — the hold is freed exactly once.
 *
 * One hold covers the whole run, sized by its ai-step count (a step chain bills
 * once per ai step). A deterministic-only chain runs no model: no gate, no hold.
 */
export async function acquireWorkflowCreditHold(
  userId: string,
  workflow: WorkflowStepSource,
  mode: WorkflowRunMode,
): Promise<WorkflowCreditHold> {
  const steps = resolveSteps(workflow);
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
 * Record a scheduled fire the gate refused as a terminal `cancelled` run, so the
 * workflow's run history says why it did not run (the calendar-trigger cron
 * records its skips the same way). Not `error`: nothing failed, the owner is out
 * of credits — the cron counts it as skipped, not as a failure.
 */
export async function recordCreditSkippedRun(params: {
  workflowId: string;
  source: WorkflowRunSource;
  reason: GateReason;
}): Promise<void> {
  await db.insert(workflowRuns).values({
    workflowId: params.workflowId,
    sourceTable: params.source.table,
    sourceId: params.source.id,
    triggerAt: params.source.triggerAt,
    status: 'cancelled',
    endedAt: new Date(),
    durationMs: 0,
    error: creditDeniedError(params.reason),
  });
}
