/**
 * Metering for browser sessions — billed to the paying principal exactly
 * like a sandbox (G6a requirement; S3 R14), through the same primitives:
 *
 *  - the payer is `resolveSessionPayer` (the drive's payer, else the session's
 *    owner — never the acting user of a shared agent), the rule the sandbox
 *    and storage charge streams share. An org drive's payer is the org: the
 *    browser is held and settled on the org POOL (WAL-9), recorded under the
 *    session's owner, and a missing, paused or empty pool refuses it by name;
 *  - the hold is `defaultSandboxBillingDeps.gate` (the charge's wallet and
 *    tier, the machine in-flight ceiling), placed BEFORE any browser starts;
 *  - the settlement is every elapsed interval of the session's lifetime at the browser's REAL
 *    shape (2 vCPU / 2 GB on Sprites), priced by `calculateMachineCostDollars`
 *    with the machine markup — not the default sandbox shape, which would
 *    under-recover a browser about threefold (S3 §3.6).
 *
 * Adapter only: it calls the billing primitives and passes their answers on.
 */
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { calculateMachineCostDollars } from '@pagespace/lib/monitoring/machine-pricing';
import { MACHINE_MARKUP_BPS } from '@pagespace/lib/billing/credit-pricing';
import { defaultSandboxBillingDeps } from '@pagespace/lib/services/sandbox/sandbox-billing';
import { ORG_COMPUTE_REFUSAL_MESSAGES, computeSpendKind, isOrgComputeRefusal } from '@pagespace/lib/billing/compute-charge';
import { computeSettleWalletId } from '@pagespace/lib/billing/compute-gate';
import type { BrowserMeter } from '@pagespace/browser-worker/browser-session-client';

export type BrowserBilling = {
  readonly driveId: string | null;
  /** The session's owner (the drive owner, or the acting user for a driveless context). */
  readonly ownerId: string;
  readonly agentPageId: string | null;
  readonly conversationId: string;
};

type BillingPrimitives = Pick<typeof defaultSandboxBillingDeps, 'resolveCharge' | 'gate' | 'releaseHold'> & {
  readonly trackUsage: typeof AIMonitoring.trackUsage;
  /** The wallet the charge settles on: the org pool (null when gone), undefined for a person. */
  readonly settleWalletId: typeof computeSettleWalletId;
};

const realPrimitives: BillingPrimitives = {
  resolveCharge: defaultSandboxBillingDeps.resolveCharge,
  gate: defaultSandboxBillingDeps.gate,
  releaseHold: defaultSandboxBillingDeps.releaseHold,
  trackUsage: (input) => AIMonitoring.trackUsage(input),
  settleWalletId: computeSettleWalletId,
};

export function createBrowserMeter(primitives: BillingPrimitives = realPrimitives): BrowserMeter<BrowserBilling> {
  return {
    open: async ({ driveId, ownerId }) => {
      const charge = await primitives.resolveCharge({ driveId, ownerId });
      const gated = await primitives.gate({ charge });
      if (!gated.allowed) {
        // WAL-9: a missing, paused or empty org pool is named — never a fallback to a person.
        const orgRefusal = gated.orgRefusal;
        if (orgRefusal !== undefined && isOrgComputeRefusal(orgRefusal)) return { ok: false, reason: ORG_COMPUTE_REFUSAL_MESSAGES[orgRefusal] };
        return { ok: false, reason: gated.reason ?? 'The browser could not be started: insufficient credits.' };
      }
      return { ok: true, hold: { holdId: gated.holdId ?? null, charge } };
    },
    close: async ({ billing, hold, activeSeconds, shape, substrate }) => {
      // The charge of the hold this interval was opened under. The client's renewal settles an interval
      // with the hold it carries and then RE-OPENS, which resolves the payer afresh, so a drive that moves
      // into or out of an org changes who pays from the next interval while each interval still settles on
      // the payer that held it (a settle on any other wallet would be refused).
      const { charge } = hold;
      if (activeSeconds <= 0) {
        if (hold.holdId !== null) await primitives.releaseHold(hold.holdId);
        return;
      }
      // Settle on the wallet the hold named. An org pool gone since the hold settles nothing
      // (the hold is released) — never onto the recorded person's wallet.
      const walletId = await primitives.settleWalletId(charge);
      if (walletId === null) {
        if (hold.holdId !== null) await primitives.releaseHold(hold.holdId);
        return;
      }
      await primitives.trackUsage({
        userId: charge.userId,
        walletId,
        provider: substrate,
        model: 'browser-machine',
        source: 'terminal',
        // Compute the session's person ran: on an org pool it counts toward their seat (fe9db1nm).
        spendKind: computeSpendKind(charge),
        pageId: billing.agentPageId ?? undefined,
        driveId: billing.driveId ?? undefined,
        providerCostDollars: calculateMachineCostDollars({ activeSeconds, shape }),
        duration: Math.round(activeSeconds * 1000),
        success: true,
        holdId: hold.holdId ?? undefined,
        markupBpsOverride: MACHINE_MARKUP_BPS,
        costSource: 'list_price',
        metadata: { type: 'browser_machine', activeSeconds, cpus: shape.cpus, memoryGB: shape.memoryGB, conversationId: billing.conversationId },
      });
    },
  };
}
