import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI, type GateOptions } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

type UserCreditHold =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: GateReason };

/**
 * Credit gate for an AI call made on a user's behalf outside a request route —
 * a channel mention reply, a Zoom transcript's enrichment — taken BEFORE any
 * model is built. The model calls behind it debit their real usage themselves
 * (AIMonitoring.trackUsage → consumeCredits, no holdId), so the hold only
 * reserves headroom while they run: the caller must call `release` once they
 * settle, in a `finally`. `release` is idempotent — the hold is freed exactly once.
 */
export async function acquireUserCreditHold(userId: string, opts: GateOptions): Promise<UserCreditHold> {
  const [user] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId));

  const gate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, opts);
  if (!gate.allowed) return { allowed: false, reason: gate.reason };

  const holdId = gate.holdId;
  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released || !holdId) return;
      released = true;
      void releaseHold(holdId).catch(() => {});
    },
  };
}
