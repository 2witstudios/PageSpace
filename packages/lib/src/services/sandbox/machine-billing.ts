/**
 * Default (real) billing composition for machine runs — binds the credit
 * pipeline's hold/settle/release primitives into the `SandboxBillingDeps` seam
 * `tool-runners.ts` (agent tool runs) and the realtime terminal handler
 * (interactive PTY sessions) both consume. A single shared composition so both
 * consumers meter through the exact same gate/settle/release logic and payer
 * resolution.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '../../billing/credit-gate';
import { releaseHold as releaseCreditHold } from '../../billing/credit-consume';
import {
  MACHINE_HOLD_ESTIMATE_CENTS,
  MACHINE_MAX_INFLIGHT,
  MACHINE_MARKUP_BPS,
} from '../../billing/credit-pricing';
import { resolveMachinePayerId, lookupPageOwnerId } from '../../billing/machine-payer';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import { calculateMachineCostDollars } from '../../monitoring/machine-pricing';
import { toSubscriptionTier, type SubscriptionTier } from '../../billing/subscription-tiers';
import { getCodeExecutionConcurrencyLimit } from './quota';
import type { SandboxBillingDeps } from './tool-runners';

/**
 * The gate must evaluate the PAYER's own balance/tier, not the acting user's —
 * a page agent or a Terminal viewer may not be the drive owner footing the
 * bill, so the payer's subscription tier is looked up directly rather than
 * threaded through from the caller's actor context.
 */
async function resolvePayerTier(payerId: string): Promise<SubscriptionTier> {
  const [row] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, payerId))
    .limit(1);
  return toSubscriptionTier(row?.subscriptionTier);
}

export const defaultSandboxBillingDeps: SandboxBillingDeps = {
  // PHASE 7 NOTE (Dev → Agents billing re-point, verified not re-plumbed —
  // flagged for Phase 8 cleanup, not changed here): this resolves `machinePageId`
  // via `resolveMachinePageId({ agentPageId: ctx.agentPageId, activeMachine:
  // ctx.activeMachine })` in `tool-runners.ts`'s `withMachineBilling`, the
  // SAME legacy chain the machine-tree world uses — it is NOT sandboxId-keyed
  // and carries no `agent_sessions` awareness. It happens to resolve CORRECTLY
  // for the new agent-session world too, but coincidentally rather than by
  // design: `ctx.activeMachine` is always undefined there, so `machinePageId`
  // falls through to `ctx.agentPageId` (payer via the page's owning drive —
  // correct) or, when that is null (a global-assistant session), `tenantId`
  // (which `sandbox-tools-runtime.ts`'s actor-context resolver sets to
  // `userId` for a driveless global session — also correct, since a
  // global-assistant conversation is single-user by construction, so `userId`
  // and the session's `ownerId` coincide). `resolveAgentSessionPayerId`
  // (`billing/machine-payer.ts`) is the explicit, `agent_sessions`-row-aware
  // version of this fallback (used by the storage reconcile in
  // `machine-storage-billing.ts`); re-pointing THIS runtime seam to it too
  // would need `SandboxBillingDeps`/`ToolExecutionContext` to carry the
  // session's real `ownerId` end-to-end, which the machine-tree world's
  // `activeMachine`-shaped context does not carry and which the current
  // request-side wiring supplies no cleaner value for than the `tenantId`
  // already in use. Left as-is rather than risk this well-tested runtime-billing
  // path for no behavioral gain; do the plumbing in Phase 8, alongside
  // deleting `activeMachine`/`resolveMachinePageId` themselves.
  async resolvePayerId({ tenantId, machinePageId }) {
    return resolveMachinePayerId({ tenantId, machinePageId, lookupPageOwnerId });
  },

  async gate({ payerId }) {
    const tier = await resolvePayerTier(payerId);
    // MACHINE_MAX_INFLIGHT and quota.ts's per-tier CONCURRENCY_LIMITS are two
    // independently env-configured values that are SUPPOSED to agree (this
    // flat cap set to the top tier's ceiling), but nothing enforces that once
    // either is retuned independently — an operator raising a tier's
    // semaphore without also raising this constant would have the billing
    // gate silently reject runs the semaphore itself would allow. Take the
    // max of both so this floor can never undercut the resolved payer's own
    // tier ceiling, regardless of env drift.
    const maxInFlight = Math.max(MACHINE_MAX_INFLIGHT, getCodeExecutionConcurrencyLimit(tier));
    const result = await canConsumeAI(payerId, tier, {
      estCostCents: MACHINE_HOLD_ESTIMATE_CENTS,
      maxInFlight,
    });
    return { allowed: result.allowed, holdId: result.holdId, reason: result.allowed ? undefined : result.reason };
  },

  async trackUsage({ payerId, holdId, activeSeconds, pageId }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      model: 'terminal-machine',
      source: 'terminal',
      // The machine's identifying page (resolveMachinePageId's output) — the ONE
      // attribution field the usage-breakdown's per-machine view groups on.
      pageId,
      providerCostDollars: calculateMachineCostDollars({ activeSeconds }),
      // Active-window duration (ms), matching the quantity that was billed —
      // not a request-latency figure, since there is no single "request" here.
      duration: Math.round(activeSeconds * 1000),
      success: true,
      holdId,
      // Terminal's own 1.5x substrate floor, independent of the shared AI
      // MARKUP_BPS default — see MACHINE_MARKUP_BPS's doc comment.
      markupBpsOverride: MACHINE_MARKUP_BPS,
      // Deterministic list-price cost (active seconds x published rate), not a
      // live provider-returned figure — mirrors voice's 'list_price' labeling.
      costSource: 'list_price',
      metadata: { type: 'terminal_machine', activeSeconds },
    });
  },

  async releaseHold(holdId) {
    await releaseCreditHold(holdId);
  },
};
