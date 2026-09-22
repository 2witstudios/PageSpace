/**
 * Metering for browser sessions — billed to the paying principal exactly
 * like a sandbox (G6a requirement; S3 R14), through the same primitives:
 *
 *  - the payer is `resolveSessionPayerId` (drive owner, else the session's
 *    owner — never the acting user of a shared agent), the rule the sandbox
 *    and storage charge streams share;
 *  - the hold is `defaultSandboxBillingDeps.gate` (the payer's balance and
 *    tier, the machine in-flight ceiling), placed BEFORE any browser starts;
 *  - the settlement is the session's whole lifetime at the browser's REAL
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
import type { BrowserMeter } from '@pagespace/browser-worker/browser-session-client';

export type BrowserBilling = {
  readonly driveId: string | null;
  /** The session's owner (the drive owner, or the acting user for a driveless context). */
  readonly ownerId: string;
  readonly agentPageId: string | null;
  readonly conversationId: string;
};

type BillingPrimitives = Pick<typeof defaultSandboxBillingDeps, 'resolvePayerId' | 'gate' | 'releaseHold'> & {
  readonly trackUsage: typeof AIMonitoring.trackUsage;
};

const realPrimitives: BillingPrimitives = {
  resolvePayerId: defaultSandboxBillingDeps.resolvePayerId,
  gate: defaultSandboxBillingDeps.gate,
  releaseHold: defaultSandboxBillingDeps.releaseHold,
  trackUsage: (input) => AIMonitoring.trackUsage(input),
};

export function createBrowserMeter(primitives: BillingPrimitives = realPrimitives): BrowserMeter<BrowserBilling> {
  return {
    open: async ({ driveId, ownerId }) => {
      const payerId = await primitives.resolvePayerId({ driveId, ownerId });
      const gated = await primitives.gate({ payerId });
      if (!gated.allowed) return { ok: false, reason: gated.reason ?? 'The browser could not be started: insufficient credits.' };
      return { ok: true, hold: { holdId: gated.holdId ?? null } };
    },
    close: async ({ billing, hold, activeSeconds, shape, substrate }) => {
      const payerId = await primitives.resolvePayerId({ driveId: billing.driveId, ownerId: billing.ownerId });
      if (activeSeconds <= 0) {
        if (hold.holdId !== null) await primitives.releaseHold(hold.holdId);
        return;
      }
      await primitives.trackUsage({
        userId: payerId,
        provider: substrate,
        model: 'browser-machine',
        source: 'terminal',
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
