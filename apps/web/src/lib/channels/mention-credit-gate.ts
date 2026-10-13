import { toPersonalSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { personTriggeredSpend } from '@pagespace/lib/billing/spend-target';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { creditDeniedError } from '@/lib/workflows/workflow-credit-gate';

type MentionCreditSpend = NonNullable<ToolExecutionContext['creditSpend']>;

export type MentionCreditHold =
  | { allowed: true; creditSpend: MentionCreditSpend; release: () => void }
  | { allowed: false; error: string };

/**
 * The credit gate for one mentioned agent's reply, taken before its model call.
 *
 * A channel mention spends the channel's drive wallet only, never the sender's credits
 * or allowance (SPEND-6): an uncovered wallet skips the reply. But the SENDER caused the
 * spend, so their per-consumer caps on that wallet bind (WAL-7, personTriggeredSpend): a
 * capped member cannot drain the wallet through mentions. The sender is who the hold is
 * recorded against, and bounds the fan-out: mention after mention is capped in flight
 * like chat.
 *
 * ONE reservation per reply: the hold rides into executeAskAgent as
 * `creditSpend.reservedHoldId`, which settles the reply on it (on `creditSpend.walletId`)
 * instead of reserving again — a wallet that can afford the reply once is never refused
 * for a second, phantom hold. The caller still calls `release` afterwards for the paths
 * that never reach the settle; `release` is idempotent (a settled hold is already gone).
 */
export async function acquireMentionCreditHold(input: {
  userId: string;
  driveId: string | null | undefined;
}): Promise<MentionCreditHold> {
  // A mention outside any drive has no drive wallet, and a person-less reply never falls
  // back to a person: nothing to spend, so nothing runs.
  if (!input.driveId) return { allowed: false, error: 'AI credit gate denied: no drive to spend' };

  const [sender] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, input.userId));

  const spend = personTriggeredSpend(input.driveId);
  const gate = await canConsumeAI(
    input.userId,
    toPersonalSubscriptionTier(sender?.subscriptionTier),
    { spend, maxInFlight: MAX_CHAT_INFLIGHT },
  );
  if (!gate.allowed) return { allowed: false, error: creditDeniedError(gate.reason, gate.refusal) };

  const holdId = gate.holdId;
  let released = false;
  return {
    allowed: true,
    creditSpend: { spend, walletId: gate.walletId, ...(holdId ? { reservedHoldId: holdId } : {}) },
    release: () => {
      if (released || !holdId) return;
      released = true;
      void releaseHold(holdId).catch(() => {});
    },
  };
}
