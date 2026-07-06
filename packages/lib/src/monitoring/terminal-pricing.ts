/**
 * terminal-pricing — real cost for a Machine's (Sprite's) active runtime.
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
 * assumption, tunable via env once Sprites' actual default shape is confirmed.
 *
 * The returned value is PRE-markup, like voice-pricing.ts: callers hand it to
 * `AIMonitoring.trackUsage` as `providerCostDollars`, and the credit pipeline
 * applies the same 1.5x markup (`MARKUP_BPS`) as every other AI call.
 */

/** Parse a non-negative float env override; fall back to `fallback` on absence/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Published Sprites rates, in USD per resource-hour (tasks/terminal.md: active
 * CPU-hour $0.07 + mem GB-hour $0.04375).
 */
export const TERMINAL_RATES = {
  usdPerCpuHour: envFloat('TERMINAL_USD_PER_CPU_HOUR', 0.07),
  usdPerMemGbHour: envFloat('TERMINAL_USD_PER_MEM_GB_HOUR', 0.04375),
};

/**
 * Assumed default machine shape (vCPUs / RAM in GB) used to price active
 * runtime, since no per-run resource allocation is read back from Sprites.
 * Env-overridable so this can track Sprites' real default shape without a
 * deploy.
 */
export const TERMINAL_ASSUMED_CPUS = envFloat('TERMINAL_ASSUMED_CPUS', 1);
export const TERMINAL_ASSUMED_MEMORY_GB = envFloat('TERMINAL_ASSUMED_MEMORY_GB', 0.25);

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
