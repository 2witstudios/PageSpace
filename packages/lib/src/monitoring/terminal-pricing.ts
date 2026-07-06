/**
 * terminal-pricing — real cost + customer charge for a Machine's (Sprite's) active
 * runtime.
 *
 * Sprites bill CPU-hour + memory GB-hour while ACTIVE, per second; hibernated
 * (idle) time is free (sprites.dev/api/sprites — Services API start/stop). The
 * app doesn't read back the actual per-run CPU/mem allocation from Sprites — no
 * resource caps are set at creation (see sandbox-options.ts's
 * `SandboxResourceCaps`: `ramMB`/`cpus` are both optional, unset -> provider
 * default) — so, mirroring the assumed-budget pattern already used for the
 * model-aware chat hold (`CHAT_HOLD_ASSUMED_INPUT_TOKENS`), cost is computed as
 *   exact active SECONDS x an ASSUMED default machine shape's per-second rate.
 * The billed QUANTITY (active seconds) is exact — measured wall-clock from
 * machine acquisition to release/session-end; only the machine SHAPE is an
 * assumption, tunable via env (credit-pricing.ts) once Sprites' actual default
 * shape is confirmed.
 *
 * `calculateTerminalCostDollars` returns the PRE-markup real cost, like
 * voice-pricing.ts: callers hand it to `AIMonitoring.trackUsage` as
 * `providerCostDollars`, and the shared credit pipeline (`consumeCredits`)
 * applies the same `MARKUP_BPS` markup as every other AI call — that markup
 * defaults to 15000 bps (1.5x), which is the floor the founder has set for
 * substrate runtime: the charge must never fall below 1.5x actual substrate
 * cost, regardless of which substrate (Sprites today, Modal/GPU later) produced
 * that cost.
 *
 * `calculateTerminalChargeCents` mirrors that same formula for pure unit-test
 * coverage of the arithmetic, but it is NOT itself in the real settle path —
 * `machine-billing.ts` hands `calculateTerminalCostDollars` (pre-markup) to
 * `AIMonitoring.trackUsage`, which applies `MARKUP_BPS` generically for every
 * source, terminal included. The "1.5x floor" holds today only because
 * `MARKUP_BPS` itself defaults to 15000 bps for every surface — there is no
 * terminal-specific enforcement independent of that shared, global constant.
 * If `MARKUP_BPS` is ever split per-source, this function's result would
 * silently stop matching what terminal is actually billed at.
 */

import { markupCents } from '../billing/credit-core';
import {
  MARKUP_BPS,
  TERMINAL_RATES,
  TERMINAL_ASSUMED_CPUS,
  TERMINAL_ASSUMED_MEMORY_GB,
  TERMINAL_STORAGE_USD_PER_GB_MONTH,
} from '../billing/credit-pricing';

export interface TerminalUsageQuantity {
  /** Wall-clock seconds the machine was ACTIVE (not hibernating) for this run. */
  activeSeconds?: number;
}

/**
 * Real provider cost (USD, pre-markup) for one machine run. Returns 0 for a
 * missing/invalid quantity — never a negative or NaN charge, so a malformed
 * call is billed nothing rather than corrupting the ledger.
 */
export function calculateTerminalCostDollars(quantity: TerminalUsageQuantity): number {
  const seconds = quantity.activeSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
  const perSecondRate =
    (TERMINAL_ASSUMED_CPUS * TERMINAL_RATES.usdPerCpuHour +
      TERMINAL_ASSUMED_MEMORY_GB * TERMINAL_RATES.usdPerMemGbHour) /
    3600;
  return Number((seconds * perSecondRate).toFixed(6));
}

/**
 * Reference calculation (whole cents) of what a machine run's real substrate
 * cost marked up by `MARKUP_BPS` comes to — the same formula `consumeCredits`
 * applies at settle, reused here for arithmetic unit-test coverage. NOT called
 * by the real settle path (see module doc): the actual charge is computed by
 * `consumeCredits` from `calculateTerminalCostDollars`'s pre-markup output, not
 * by this function. Returns 0 for a missing/invalid/zero-duration window.
 */
export function calculateTerminalChargeCents(quantity: TerminalUsageQuantity): number {
  return markupCents(calculateTerminalCostDollars(quantity), MARKUP_BPS);
}

/**
 * Real provider cost (USD, pre-markup) for persistent Machine storage over a
 * span of GB-months (gigabytes x months held). Pure and unit-tested ahead of
 * the idle-storage cron (Epic 3) that will be its first caller — mirrors the
 * same "assumed rate x exact billed quantity" shape as active-runtime cost.
 * Returns 0 for a missing/invalid/non-positive quantity.
 */
export function calculateTerminalStorageCostDollars(gbMonths: number): number {
  if (typeof gbMonths !== 'number' || !Number.isFinite(gbMonths) || gbMonths <= 0) return 0;
  return Number((gbMonths * TERMINAL_STORAGE_USD_PER_GB_MONTH).toFixed(6));
}
