/**
 * Default (real) billing composition for agent-session sandbox runs — binds
 * the credit pipeline's hold/settle/release primitives into the
 * `SandboxBillingDeps` seam `tool-runners.ts` (agent tool runs) and the
 * realtime shell handler (interactive PTY sessions) both consume. A single
 * shared composition so both consumers meter through the exact same
 * gate/settle/release logic and payer resolution.
 */

import { releaseHold as releaseCreditHold } from '../../billing/credit-consume';
import {
  MACHINE_HOLD_ESTIMATE_CENTS,
  MACHINE_MAX_INFLIGHT,
  MACHINE_MARKUP_BPS,
} from '../../billing/credit-pricing';
import { resolveSessionPayer, lookupDriveBillingFacts } from '../../billing/sandbox-payer';
import { computeChargeFor, computeSpendKind } from '../../billing/compute-charge';
import { computeSettleWalletId, gateComputeCharge, UNSETTLED_COMPUTE } from '../../billing/compute-gate';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import { calculateMachineCostDollars } from '../../monitoring/machine-pricing';
import { getCodeExecutionConcurrencyLimit } from './quota';
import type { SandboxBillingDeps } from './tool-runners';

export const defaultSandboxBillingDeps: SandboxBillingDeps = {
  // Resolves from the ACQUIRED SESSION's own driveId/ownerId (never the
  // caller's surface drive or agent page) — `resolveSessionPayer` is the
  // same drive-payer-else-session-owner rule `storageBillingTarget` applies
  // for the storage charge stream, so both streams bill one payer for one
  // session regardless of which conversation/drive the caller happened to be
  // in when the run started. An org drive's session charges the ORG POOL (WAL-9), recorded under
  // the ACTOR — the person who caused the run, whose per-member cap it counts toward — never the
  // session's owner (a drive session is shared) and never anyone's own wallet.
  async resolveCharge({ driveId, ownerId, actorId }) {
    return computeChargeFor(await resolveSessionPayer({ driveId, ownerId, lookupDriveBillingFacts }), actorId);
  },

  async gate({ charge }) {
    // MACHINE_MAX_INFLIGHT and quota.ts's per-tier CONCURRENCY_LIMITS are two
    // independently env-configured values that are SUPPOSED to agree (this
    // flat cap set to the top tier's ceiling), but nothing enforces that once
    // either is retuned independently — an operator raising a tier's
    // semaphore without also raising this constant would have the billing
    // gate silently reject runs the semaphore itself would allow. Take the
    // max of both so this floor can never undercut the resolved payer's own
    // tier ceiling, regardless of env drift.
    // The tier is the CHARGE's: the org's for an org drive, the paying person's otherwise.
    const result = await gateComputeCharge(charge, {
      estCostCents: MACHINE_HOLD_ESTIMATE_CENTS,
      maxInFlight: (tier) => Math.max(MACHINE_MAX_INFLIGHT, getCodeExecutionConcurrencyLimit(tier)),
    });
    return result.allowed
      ? { allowed: true, holdId: result.holdId }
      : { allowed: false, reason: result.reason, orgRefusal: result.orgRefusal };
  },

  async trackUsage({ charge, holdId, activeSeconds, pageId, driveId, workspaceId }) {
    // Settle on the wallet the hold named: the org pool for an org charge. A pool gone since
    // the hold does not settle (the hold is released by the caller) — never onto a person.
    const walletId = await computeSettleWalletId(charge);
    if (walletId === null) return UNSETTLED_COMPUTE;
    // Returned, not awaited-and-discarded: the seam's whole point is that the
    // caller learns whether the charge is durable (see `UsageTrackingOutcome`).
    return AIMonitoring.trackUsage({
      userId: charge.userId,
      walletId,
      provider: 'sprites',
      model: 'terminal-machine',
      source: 'terminal',
      // Compute the session's person ran: on an org pool it counts toward their seat (fe9db1nm).
      spendKind: computeSpendKind(charge),
      // The referenced agent page — purely descriptive per-agent grouping,
      // never the payer source (resolved from the session by `resolveCharge`
      // above).
      pageId,
      // First-class drive/session attribution (Terminal Epic 3 usage-breakdown
      // fix) — the SAME session driveId/ownerId the payer was resolved from,
      // so the breakdown can group runtime spend by session/drive without
      // JSON forensics, consistently with the storage charge stream.
      driveId,
      // `AIUsageData.sessionId` is the shared analytics column (`monitoring.session_id`),
      // written by many sources — out of this rename's scope, so map at the boundary.
      sessionId: workspaceId,
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
