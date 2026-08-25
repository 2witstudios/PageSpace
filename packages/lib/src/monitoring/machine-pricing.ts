/**
 * machine-pricing — real cost + customer charge for a Machine's (Sprite's) active
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
 * `calculateMachineCostDollars` returns the PRE-markup real cost, like
 * voice-pricing.ts: callers (machine-billing.ts, machine-storage-billing.ts)
 * hand it to `AIMonitoring.trackUsage` as `providerCostDollars` ALONGSIDE
 * `markupBpsOverride: MACHINE_MARKUP_BPS` (credit-pricing.ts), so the shared
 * credit pipeline (`consumeCredits`) marks it up at the machine's own 1.5x
 * substrate floor rather than the general-purpose `MARKUP_BPS` every other AI
 * call gets. The two constants happen to share the same default (15000 bps)
 * today but are independent env vars — lowering `CREDIT_MARKUP_BPS` for
 * AI-model billing cannot silently lower what a machine is charged.
 */

import {
  MACHINE_RATES,
  MACHINE_ASSUMED_CPUS,
  MACHINE_ASSUMED_MEMORY_GB,
  MACHINE_STORAGE_USD_PER_GB_MONTH,
  PUBLISHED_APP_ASSUMED_CPUS,
  PUBLISHED_APP_ASSUMED_MEMORY_GB,
} from '../billing/credit-pricing';

export interface MachineUsageQuantity {
  /** Wall-clock seconds the machine was ACTIVE (not hibernating) for this run. */
  activeSeconds?: number;
  /**
   * The guest this runtime actually ran on. Omitted -> the assumed sandbox shape
   * (see the module doc): Sprites sets no resource caps, so its shape genuinely
   * has to be assumed.
   *
   * A PUBLISHED APP's shape is not assumed — `published_apps.guestPreset` is
   * pinned by a CHECK constraint, so that meter passes
   * {@link PUBLISHED_APP_GUEST_SHAPE} and is billed for the guest we asked Fly
   * for. Reusing the sandbox default there would under-bill every awake second
   * by half the memory component, invisibly, for as long as the two shapes
   * differed.
   */
  shape?: MachineShape;
}

/** vCPUs and RAM, the two quantities the published rate table prices. */
export interface MachineShape {
  cpus: number;
  memoryGB: number;
}

/** The assumed default SANDBOX (Sprites) shape — no caps are set at creation, so this is a genuine assumption. */
export const SANDBOX_GUEST_SHAPE: MachineShape = {
  cpus: MACHINE_ASSUMED_CPUS,
  memoryGB: MACHINE_ASSUMED_MEMORY_GB,
};

/** The v1 published-app guest (`shared-cpu-1x-512`) — known, not assumed. */
export const PUBLISHED_APP_GUEST_SHAPE: MachineShape = {
  cpus: PUBLISHED_APP_ASSUMED_CPUS,
  memoryGB: PUBLISHED_APP_ASSUMED_MEMORY_GB,
};

/**
 * Real provider cost (USD, pre-markup) for one machine run. Returns 0 for a
 * missing/invalid quantity — never a negative or NaN charge, so a malformed
 * call is billed nothing rather than corrupting the ledger.
 */
export function calculateMachineCostDollars(quantity: MachineUsageQuantity): number {
  const seconds = quantity.activeSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
  const shape = quantity.shape ?? SANDBOX_GUEST_SHAPE;
  const perSecondRate =
    (shape.cpus * MACHINE_RATES.usdPerCpuHour + shape.memoryGB * MACHINE_RATES.usdPerMemGbHour) / 3600;
  return Number((seconds * perSecondRate).toFixed(6));
}

/**
 * Real provider cost (USD, pre-markup) for persistent Machine storage over a
 * span of GB-months (gigabytes x months held). Pure and unit-tested ahead of
 * the idle-storage cron (Epic 3) that will be its first caller — mirrors the
 * same "assumed rate x exact billed quantity" shape as active-runtime cost.
 * Returns 0 for a missing/invalid/non-positive quantity.
 */
export function calculateMachineStorageCostDollars(gbMonths: number): number {
  if (typeof gbMonths !== 'number' || !Number.isFinite(gbMonths) || gbMonths <= 0) return 0;
  return Number((gbMonths * MACHINE_STORAGE_USD_PER_GB_MONTH).toFixed(6));
}
