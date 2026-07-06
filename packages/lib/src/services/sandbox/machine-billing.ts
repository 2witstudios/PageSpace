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
import { TERMINAL_HOLD_ESTIMATE_CENTS, TERMINAL_MAX_INFLIGHT } from '../../billing/credit-pricing';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import { calculateTerminalCostDollars } from '../../monitoring/terminal-pricing';
import type { SubscriptionTier } from '../subscription-utils';
import type { SandboxBillingDeps } from './tool-runners';

const VALID_TIERS: ReadonlySet<string> = new Set(['free', 'pro', 'founder', 'business']);

function toTier(value: string | null | undefined): SubscriptionTier {
  return value && VALID_TIERS.has(value) ? (value as SubscriptionTier) : 'free';
}

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
  return toTier(row?.subscriptionTier);
}

export const defaultSandboxBillingDeps: SandboxBillingDeps = {
  async gate({ payerId }) {
    const tier = await resolvePayerTier(payerId);
    const result = await canConsumeAI(payerId, tier, {
      estCostCents: TERMINAL_HOLD_ESTIMATE_CENTS,
      maxInFlight: TERMINAL_MAX_INFLIGHT,
    });
    return { allowed: result.allowed, holdId: result.holdId, reason: result.allowed ? undefined : result.reason };
  },

  async trackUsage({ payerId, holdId, activeSeconds }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      model: 'terminal-machine',
      source: 'terminal',
      providerCostDollars: calculateTerminalCostDollars({ activeSeconds }),
      // Active-window duration (ms), matching the quantity that was billed —
      // not a request-latency figure, since there is no single "request" here.
      duration: Math.round(activeSeconds * 1000),
      success: true,
      holdId,
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
