import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI, type GateOptions, type SpendRefusal } from '@pagespace/lib/billing/credit-gate';
import { automationSpend } from '@pagespace/lib/billing/spend-target';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { CREDIT_HOLD_ESTIMATE_CENTS, MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { resolveSteps, hasAiStep, countAiSteps } from './core/step-plan';
import type { RunAdmission, RunCreditSpend, WorkflowExecutionInput } from './workflow-executor';

/**
 * How a run was started, which decides the gate's caps:
 *   - interactive: a user pressed Run. Same bounds as chat — the per-user/day
 *     exposure cap applies and the in-flight cap stops a click-storm fan-out.
 *   - scheduled: a cron fired it. Like the calendar/zoom trigger executors, the
 *     interactive daily backstop does not apply (one fire per schedule tick).
 */
type WorkflowRunMode = 'interactive' | 'scheduled';

type WorkflowCreditHold =
  | { allowed: true; release: () => void; creditSpend: RunCreditSpend }
  | { allowed: false; reason: GateReason; refusal?: SpendRefusal };

/** The parts of a run's input the gate reads: where it spends, who it is recorded against, and what will run. */
type GatedRunInput = Pick<WorkflowExecutionInput, 'driveId' | 'createdBy' | 'steps' | 'prompt' | 'agentPageId'>;

/**
 * The run error for a denied gate — the same text the trigger executors return. A refused
 * source adds why, so a skipped automation's run row says its drive wallet was empty,
 * paused, or missing (SPEND-6).
 */
export const creditDeniedError = (reason: GateReason, refusal?: SpendRefusal): string =>
  refusal ? `AI credit gate denied: ${reason} (${refusal.reason})` : `AI credit gate denied: ${reason}`;

/**
 * Credit gate for a workflow run, taken BEFORE executeWorkflow builds a model.
 * A run has no person present, so its consumer is the drive it runs in: it
 * reserves on the drive wallet or is skipped, never on its creator's credits or
 * allowance (SPEND-6). `createdBy` is only who the hold and usage are recorded
 * against. The reservation is sized from the steps that will actually execute.
 * Callers pass it to the executor through `creditAdmission` rather than calling
 * it before the run. executeWorkflow debits real usage itself
 * (AIMonitoring.trackUsage → consumeCredits, no holdId) on the wallet named in
 * `creditSpend`, so the hold only reserves headroom while the run is in flight:
 * the caller must call `release` once the run settles, in a `finally`.
 * `release` is idempotent — the hold is freed exactly once.
 *
 * One hold covers the whole run, sized by its ai-step count (a step chain bills
 * once per ai step). A deterministic-only chain runs no model: no gate, no hold.
 */
export async function acquireWorkflowCreditHold(
  input: GatedRunInput,
  mode: WorkflowRunMode,
): Promise<WorkflowCreditHold> {
  const userId = input.createdBy;
  // SPEND-6: a workflow run has no person present; its consumer is the drive, and it
  // spends the drive wallet or is skipped — never its creator's credits or allowance.
  const target = automationSpend(input.driveId);
  const steps = resolveSteps({ steps: input.steps ?? null, prompt: input.prompt, agentPageId: input.agentPageId });
  if (!hasAiStep(steps)) return { allowed: true, release: () => {}, creditSpend: { spend: target } };

  const [user] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId));

  const estCostCents = CREDIT_HOLD_ESTIMATE_CENTS * countAiSteps(steps);
  const opts: GateOptions = mode === 'interactive'
    ? { spend: target, estCostCents, maxInFlight: MAX_CHAT_INFLIGHT }
    : { spend: target, estCostCents, skipDailyCap: true };

  const gate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, opts);
  if (!gate.allowed) return gate.refusal ? { allowed: false, reason: gate.reason, refusal: gate.refusal } : { allowed: false, reason: gate.reason };

  // The run settles on the wallet the gate reserved on (WAL-5): the drive wallet once
  // wallets are on; while orgs are dark, the personal root as before wallets.
  const creditSpend: RunCreditSpend = { spend: target, walletId: gate.walletId };
  const holdId = gate.holdId;
  if (!holdId) return { allowed: true, release: () => {}, creditSpend };

  let released = false;
  return {
    allowed: true,
    creditSpend,
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
    if (hold.allowed) return { admitted: true, release: hold.release, creditSpend: hold.creditSpend };
    onDenied?.(hold.reason);
    return { admitted: false, error: creditDeniedError(hold.reason, hold.refusal) };
  };
}
