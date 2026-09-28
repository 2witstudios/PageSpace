/**
 * The credit reservation each model call of the nightly memory cron takes before it runs
 * (SPEND-1). The cron learns a person's own profile from their own activity, outside any
 * drive, so it spends their personal credits (SPEND-8) — never a drive's.
 *
 * On an allowed reservation the call settles its real usage once, handing `holdId` and
 * `walletId` to AIMonitoring.trackUsage, which settles the hold. Every path that ends
 * before that settle (the model threw) calls `release`. A refused reservation means the
 * call does not run: each service then returns exactly what it returns when its provider is
 * unavailable, so nothing half-written is persisted.
 */

import { callAdmission } from '@pagespace/lib/billing/call-admission';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { PERSONAL_SPEND } from '@pagespace/lib/billing/spend-target';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { gateUserCall } from '@/lib/ai/core/user-credit-hold';

export type MemoryCallReservation =
  | { allowed: true; holdId: string | undefined; walletId: string | undefined; release: () => void }
  | { allowed: false; reason: string };

/** Characters per token, the same rough ratio estimateTokens uses. */
const CHARS_PER_TOKEN = 4;

export async function reserveMemoryCall(
  userId: string,
  call: { provider: string; model: string; inputChars: number },
): Promise<MemoryCallReservation> {
  const admission = callAdmission({
    meteringExempt: isMeteringExempt(call.provider),
    spend: PERSONAL_SPEND,
    estCostCents: estimateChatHoldCentsForModel(call.model, { inputTokens: Math.ceil(call.inputChars / CHARS_PER_TOKEN) }),
  });
  if (!admission.gate) return { allowed: true, holdId: undefined, walletId: undefined, release: () => {} };

  // A background run, like the pulse cron: the per-day cap is the interactive runaway
  // backstop, and the reservation itself still bounds what this call can spend.
  const gate = await gateUserCall(userId, { spend: admission.spend, estCostCents: admission.estCostCents, skipDailyCap: true });
  if (!gate.allowed) return { allowed: false, reason: gate.reason };

  const holdId = gate.holdId;
  let released = false;
  return {
    allowed: true,
    holdId,
    walletId: gate.walletId,
    release: () => {
      if (released || !holdId) return;
      released = true;
      void releaseHold(holdId).catch(() => {});
    },
  };
}
