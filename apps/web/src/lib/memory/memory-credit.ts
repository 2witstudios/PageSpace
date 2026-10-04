/**
 * The credit reservation each model call of the nightly memory cron takes before it runs
 * (SPEND-1). The cron learns a person's own profile from their own activity, outside any
 * drive, so it spends their personal credits (SPEND-8) — never a drive's.
 *
 * This is the ONLY hold a memory model call takes. On an allowed reservation the call
 * settles its real usage once, handing `holdId` and `walletId` to AIMonitoring.trackUsage,
 * which settles the hold. Every path that ends before that settle (the model threw) calls
 * `release`. A refused reservation means the call does not run: each service then returns
 * exactly what it returns when its provider is unavailable, so nothing half-written is
 * persisted, and reports the refusal so the cron can surface it.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { callAdmission } from '@pagespace/lib/billing/call-admission';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { PERSONAL_SPEND } from '@pagespace/lib/billing/spend-target';
import { isMemoryAvailable } from '@pagespace/lib/billing/automation-preferences';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { gateUserCall } from '@/lib/ai/core/user-credit-hold';
import { errorLogFields } from '@pagespace/lib/logging/error-cause';

/**
 * Why a memory model call did not run:
 *   - a credit gate reason (out of credits, in debt, needs_init, …)
 *   - `tier_not_eligible`: the user's tier does not get Memory at all. The cron
 *     already selects only MEMORY_PAYING_TIERS; this is the second lock, so the
 *     credit balance is never the only thing between a free user and a model.
 *   - `gate_error`: the gate itself could not be evaluated (DB outage, lock
 *     timeout). A nightly pass is optional work, so an unanswerable gate is a
 *     refusal, never a pass.
 */
export type MemoryGateRefusal = GateReason | 'tier_not_eligible' | 'gate_error';

export type MemoryCallReservation =
  | { allowed: true; holdId: string | undefined; walletId: string | undefined; release: () => void }
  | { allowed: false; reason: MemoryGateRefusal };

/** Characters per token, the same rough ratio estimateTokens uses. */
const CHARS_PER_TOKEN = 4;

export async function reserveMemoryCall(
  userId: string,
  call: { provider: string; model: string; inputChars: number },
): Promise<MemoryCallReservation> {
  let holdId: string | undefined;
  let walletId: string | undefined;
  try {
    const [user] = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId));
    if (!isMemoryAvailable((user?.subscriptionTier ?? 'free') as SubscriptionTier)) {
      return { allowed: false, reason: 'tier_not_eligible' };
    }

    const admission = callAdmission({
      meteringExempt: isMeteringExempt(call.provider),
      spend: PERSONAL_SPEND,
      estCostCents: estimateChatHoldCentsForModel(call.model, { inputTokens: Math.ceil(call.inputChars / CHARS_PER_TOKEN) }),
    });
    if (admission.gate) {
      // A background run, like the pulse cron: the per-day cap is the interactive runaway
      // backstop, and the reservation itself still bounds what this call can spend.
      const gate = await gateUserCall(userId, { spend: admission.spend, estCostCents: admission.estCostCents, skipDailyCap: true });
      if (!gate.allowed) return { allowed: false, reason: gate.reason };
      holdId = gate.holdId;
      walletId = gate.walletId;
    }
  } catch (error) {
    loggers.api.warn('Memory: credit gate could not be evaluated, call skipped', {
      userId,
      ...errorLogFields(error),
    });
    return { allowed: false, reason: 'gate_error' };
  }

  let released = false;
  return {
    allowed: true,
    holdId,
    walletId,
    release: () => {
      if (released || !holdId) return;
      released = true;
      void releaseHold(holdId).catch(() => {});
    },
  };
}
