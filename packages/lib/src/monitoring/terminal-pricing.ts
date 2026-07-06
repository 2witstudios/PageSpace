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
 * that cost. `calculateTerminalChargeCents` mirrors that exact formula so the
 * rule is independently pure-tested here, substrate-neutral and env-overridable.
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
 * Customer-facing charge (whole cents) for one machine run: real substrate cost
 * marked up by `MARKUP_BPS` — the same formula `consumeCredits` applies at
 * settle, reused here so the "at minimum 1.5x actual substrate cost" rule is
 * pinned and pure-tested independent of the shared billing pipeline. Returns 0
 * for a missing/invalid/zero-duration window (nothing to charge).
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
