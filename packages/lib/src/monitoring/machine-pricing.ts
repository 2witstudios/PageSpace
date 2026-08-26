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
  MACHINE_MARKUP_BPS,
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

/**
 * Hours in a billing month, for turning a per-hour substrate rate into a flat
 * monthly figure. 730 = 8760/12, the conventional average — NOT the length of
 * any particular month.
 *
 * Deliberately not env-overridable: it is a unit conversion, not a price. Every
 * knob that should move a price ({@link MACHINE_RATES}, {@link MACHINE_MARKUP_BPS})
 * already is one, and a second, subtler lever on the same number would let a
 * markup floor be evaded without touching the constant that names it.
 */
export const HOURS_PER_BILLING_MONTH = 730;

/**
 * The FLOOR price, in whole cents per month, for an always-on machine of this
 * shape — the dedicated (flat monthly SKU) tier's cost basis.
 *
 * WHAT THIS IS FOR, because it is not a list price. The dedicated tier sells a
 * machine that is awake all 730 hours, so its substrate cost is knowable in
 * advance rather than metered — and the founder-set rule that Machine billing
 * never falls below 1.5x real substrate cost ({@link MACHINE_MARKUP_BPS}, floored
 * by `MACHINE_MARKUP_FLOOR_BPS}) has to bind on that SKU too. A flat price is set
 * in Stripe by a human, so the only way for that floor to bind is for the code to
 * REFUSE a price below it. This function is that threshold; the list price is
 * whatever the operator configured in Stripe, and the guard only stops us selling
 * an always-on machine for less than it costs us x1.5.
 *
 * Rounded UP to the cent: rounding a floor down would let a price a fraction of a
 * cent under it pass a check whose entire purpose is that nothing passes under it.
 *
 * READ THE NUMBER IT PRODUCES BEFORE TRUSTING IT AS ECONOMICS. `MACHINE_RATES` is
 * the published SPRITES rate for bursty sandbox runtime (active CPU-hour $0.07 +
 * mem GB-hour $0.04375). Applied across a whole month it prices `shared-cpu-1x-512`
 * at ~$100/month against a real Fly cost of roughly $3/month for the same guest.
 * Reusing it here is the founder-economics interim decision (one rate table for
 * every machine, no second pricing surface to keep in sync) and it is deliberately
 * conservative in the safe direction — a floor set too high refuses a sale, a floor
 * set too low sells at a loss. When hosting gets its own rate table, this function
 * is the one place that changes.
 *
 * Returns 0 for a malformed shape rather than throwing or inventing a number: a
 * zero floor makes the caller's guard pass, which is correct, because a shape we
 * cannot price is one this function has no opinion about — the CALLER refuses an
 * unknown preset (see `guestForPreset`), and a floor is not the place to relitigate
 * that.
 */
export function calculateDedicatedMonthlyFloorCents(shape: MachineShape): number {
  const { cpus, memoryGB } = shape;
  if (!Number.isFinite(cpus) || !Number.isFinite(memoryGB) || cpus < 0 || memoryGB < 0) return 0;
  const usdPerHour = cpus * MACHINE_RATES.usdPerCpuHour + memoryGB * MACHINE_RATES.usdPerMemGbHour;
  const substrateCents = usdPerHour * HOURS_PER_BILLING_MONTH * 100;
  return Math.ceil((substrateCents * MACHINE_MARKUP_BPS) / 10000);
}
