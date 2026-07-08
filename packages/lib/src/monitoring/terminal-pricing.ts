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
 * voice-pricing.ts: callers (machine-billing.ts, terminal-storage-billing.ts)
 * hand it to `AIMonitoring.trackUsage` as `providerCostDollars` ALONGSIDE
 * `markupBpsOverride: TERMINAL_MARKUP_BPS` (credit-pricing.ts), so the shared
 * credit pipeline (`consumeCredits`) marks it up at terminal's own 1.5x
 * substrate floor rather than the general-purpose `MARKUP_BPS` every other AI
 * call gets. The two constants happen to share the same default (15000 bps)
 * today but are independent env vars — lowering `CREDIT_MARKUP_BPS` for
 * AI-model billing cannot silently lower what terminal is charged.
 */

import {
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
