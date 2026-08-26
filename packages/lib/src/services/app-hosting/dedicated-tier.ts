/**
 * dedicated-tier — everything the DEDICATED (flat monthly) published-app tier
 * decides, as pure functions.
 *
 * INVARIANT: zero I/O. No db, no fetch, no clock. Same arrangement, and the same
 * reason, as `provisioner-core` and `app-metering-core` beside it — the tier is a
 * billing product, and a billing product's rules should be exhaustively testable
 * without a database or a Stripe account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE TIER ACTUALLY IS. `metered` and `dedicated` run the SAME pipeline:
 * same provisioner, same builder, same blue/green deploy, same router. Four
 * things differ, and they are all here:
 *
 *   1. NO BALANCE GATE. A dedicated app is paid for by a flat monthly
 *      subscription, so there is nothing for a credit balance to say about it.
 *      `decideAppRoute` already reads the tier for this (`router-core.ts`), and
 *      {@link isCreditMetered} is the same fact stated once for everybody else.
 *   2. NO AWAKE DRAIN. The corollary, and the half that is easy to forget: an
 *      app that skips the gate must also skip the METER, or the customer pays a
 *      flat monthly price AND per-awake-second credits for the same machine.
 *   3. ALWAYS ON. `min_machines_running: 1` in the machine's service config, so
 *      Fly's proxy keeps one machine up rather than letting it scale to zero.
 *   4. REAPER-EXEMPT. The idle reaper stops apps that stop being hit; stopping a
 *      dedicated app is stopping the thing the customer is paying for.
 *
 * The database enforces the one direction that must never be representable: a
 * `parked` dedicated row (`published_apps_parked_is_metered_only`). Parking IS
 * credit-exhaustion enforcement, and an app with no credit gate cannot have been
 * refused by one. Everything else here is policy, and policy lives in code.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { PublishedAppStatus, PublishedAppTier } from '@pagespace/db/schema/published-apps';
import type { MachineConfig } from '../fly/flaps-client';
import {
  calculateDedicatedMonthlyFloorCents,
  type MachineShape,
} from '../../monitoring/machine-pricing';

/**
 * Whether this tier's runtime is charged per awake-second against credits.
 *
 * The single statement of "who does the credit pipeline apply to", read by the
 * wake gate, the heartbeat meter and the router alike. Written as a function of
 * the tier rather than as `tier === 'metered'` at four call sites so that adding
 * a third tier is one edit here and a type error everywhere it matters, instead
 * of four `=== 'metered'` comparisons that all still compile and all now mean
 * something subtly wrong.
 */
export function isCreditMetered(tier: PublishedAppTier): boolean {
  return tier === 'metered';
}

/**
 * Whether the idle reaper must leave this app alone.
 *
 * THE ONLY THING KEEPING A DEDICATED APP ALWAYS-ON IS THIS PREDICATE plus
 * {@link DEDICATED_MIN_MACHINES_RUNNING}. The database does not help here: the
 * status machine's `running -> stopped` edge is legal for BOTH tiers (only
 * `running -> parked` is metered-only), and it has to be — an operator stop and
 * a redeploy both need it. So a reaper that forgets to call this will happily
 * stop a machine somebody is paying a flat monthly price to keep up, and nothing
 * downstream will refuse it.
 *
 * Exported ahead of its caller on purpose: the reaper is built on a sibling
 * branch, and keying the exemption on the TIER — rather than on a column the
 * reaper owns — is what lets the two land in either order without touching each
 * other's files. Both branches implement the same rule independently while they
 * are separate (the reaper's row source filters `tier = 'metered'` in SQL), and
 * whichever of the two merges SECOND rewires that predicate to this function, so
 * the rule ends up stated once. Until then this export is deliberately
 * caller-less in its own branch.
 */
export function isIdleReaperExempt(tier: PublishedAppTier): boolean {
  return tier === 'dedicated';
}

/**
 * `min_machines_running` for a dedicated app's service.
 *
 * ONE, not more: this tier is "always on", not "replicated". A second machine
 * doubles the substrate cost the flat price was derived from
 * ({@link calculateDedicatedMonthlyFloorCents} prices ONE guest) and buys an
 * availability property nobody has sold. Multi-machine is a different SKU.
 */
export const DEDICATED_MIN_MACHINES_RUNNING = 1;

/** `min_machines_running` for a metered app: scale to zero is the whole product. */
export const METERED_MIN_MACHINES_RUNNING = 0;

/** The `min_machines_running` a tier's machine service is configured with. */
export function minMachinesRunningFor(tier: PublishedAppTier): number {
  return tier === 'dedicated' ? DEDICATED_MIN_MACHINES_RUNNING : METERED_MIN_MACHINES_RUNNING;
}

// ── Guest presets ────────────────────────────────────────────────────────────

/**
 * A sellable guest size.
 *
 * `name` is the value stored in `published_apps.guestPreset` and constrained by
 * `published_apps_guest_preset_allowed`; the shape is what we ask Fly for and
 * what the price floor is derived from. All three are in one record because a
 * preset whose stored name, requested shape and priced shape can drift apart is
 * a preset that can be sold at one size and run at another.
 */
export interface PublishedAppGuestPreset {
  name: string;
  cpus: number;
  memoryGB: number;
  /**
   * Which tiers may run this size.
   *
   * The small guest is the v1 unit-economics guardrail and stays available to
   * BOTH tiers. Everything larger is dedicated-only, and that is a deliberate
   * economic constraint rather than an arbitrary one: the metered meter prices
   * every awake second at {@link PUBLISHED_APP_GUEST_SHAPE}, a single fixed
   * shape, so a metered app on a bigger guest would be UNDER-BILLED by exactly
   * the difference, silently, for as long as it ran. Sizes are unlocked by
   * moving to a tier whose price already accounts for the size.
   */
  tiers: readonly PublishedAppTier[];
}

const BOTH_TIERS: readonly PublishedAppTier[] = ['metered', 'dedicated'];
const DEDICATED_ONLY: readonly PublishedAppTier[] = ['dedicated'];

/**
 * The sellable guest sizes, smallest first.
 *
 * This array is the SOURCE the `published_apps_guest_preset_allowed` CHECK
 * mirrors — widening it is an additive migration on that constraint, and the
 * pair is pinned by a test that writes a rejected preset to a real Postgres.
 *
 * `shared-cpu-8x-8192` is deliberately absent. It is a five-figure-cents monthly
 * SKU on a fixed guest and nobody has asked for it; a size that exists in the
 * catalogue is a size a customer can be sold, and an unsold size in a CHECK
 * constraint is a promise to support hardware we have never run.
 */
export const PUBLISHED_APP_GUEST_PRESETS: readonly PublishedAppGuestPreset[] = [
  { name: 'shared-cpu-1x-512', cpus: 1, memoryGB: 0.5, tiers: BOTH_TIERS },
  { name: 'shared-cpu-1x-1024', cpus: 1, memoryGB: 1, tiers: DEDICATED_ONLY },
  { name: 'shared-cpu-2x-2048', cpus: 2, memoryGB: 2, tiers: DEDICATED_ONLY },
  { name: 'shared-cpu-4x-4096', cpus: 4, memoryGB: 4, tiers: DEDICATED_ONLY },
];

/** The default (and only metered-legal) preset — the v1 unit-economics guardrail. */
export const DEFAULT_GUEST_PRESET = 'shared-cpu-1x-512';

/** Look a preset up by its stored name. Null for anything not in the catalogue. */
export function findGuestPreset(name: string): PublishedAppGuestPreset | null {
  return PUBLISHED_APP_GUEST_PRESETS.find((preset) => preset.name === name) ?? null;
}

/** The preset's machine shape, for pricing. Null for an unknown preset. */
export function guestPresetShape(name: string): MachineShape | null {
  const preset = findGuestPreset(name);
  return preset === null ? null : { cpus: preset.cpus, memoryGB: preset.memoryGB };
}

/** The sizes this tier may run, in catalogue order. */
export function guestPresetsForTier(tier: PublishedAppTier): PublishedAppGuestPreset[] {
  return PUBLISHED_APP_GUEST_PRESETS.filter((preset) => preset.tiers.includes(tier));
}

/**
 * May this (tier, preset) pair exist?
 *
 * FALSE for an unknown preset, not true — an unrecognised size must never be
 * treated as permitted by default. This mirrors
 * `published_apps_metered_guest_preset` in the database, so a pair refused here
 * is a refusal VALUE rather than a constraint violation thrown at the caller.
 */
export function isGuestPresetAllowedForTier(name: string, tier: PublishedAppTier): boolean {
  const preset = findGuestPreset(name);
  return preset !== null && preset.tiers.includes(tier);
}

/**
 * The floor price, in whole cents per month, below which this preset must not be
 * sold as dedicated. 0 for an unknown preset — see
 * {@link calculateDedicatedMonthlyFloorCents} for why a shape we cannot price
 * yields no opinion rather than an invented one; the unknown preset itself is
 * refused by {@link isGuestPresetAllowedForTier} before any price is consulted.
 */
export function dedicatedMonthlyFloorCents(name: string): number {
  const shape = guestPresetShape(name);
  return shape === null ? 0 : calculateDedicatedMonthlyFloorCents(shape);
}

// ── Stripe subscription routing ──────────────────────────────────────────────

/**
 * The metadata key/value stamped on every dedicated-hosting Stripe subscription.
 *
 * This pair is the ONLY thing separating a hosting charge from an account plan in
 * the webhook, and the separation is load-bearing in both directions:
 *
 *   - a hosting subscription that reached `handleSubscriptionChange` would derive
 *     an account tier of `free` from its unmapped price and write that over a
 *     paying customer's tier, permanently (see the docblock on
 *     `published_app_subscriptions`);
 *   - an account plan that reached the hosting handler would be mirrored as a
 *     subscription for an app that does not exist.
 *
 * `kind` rather than something hosting-specific because it is a discriminator for
 * ALL subscription kinds this account may later sell, and a discriminator named
 * after its first value ages badly.
 */
export const SUBSCRIPTION_KIND_METADATA_KEY = 'kind';
export const DEDICATED_SUBSCRIPTION_KIND = 'published_app_dedicated';

/**
 * What a Stripe subscription's metadata says this subscription IS.
 *
 *  - `account_plan` — no `kind` at all. EVERY subscription that exists today is
 *    this, which is why the absent case maps here rather than to `unknown`: the
 *    existing path must stay byte-identical for every subscription written before
 *    this discriminator existed. Fail-closed means "the old behaviour", not "no
 *    behaviour".
 *  - `published_app_dedicated` — an exact match on the value above.
 *  - `unknown` — a `kind` we do not recognise. The caller LOGS it and then takes
 *    the account-plan path anyway. Dropping the event instead would be the wrong
 *    kind of safety: a typo'd or future `kind` on a real account subscription
 *    would silently stop maintaining that customer's tier, and the tier reconcile
 *    cron would have nothing to repair from.
 */
export type StripeSubscriptionKind = 'account_plan' | 'published_app_dedicated' | 'unknown';

export function classifySubscriptionKind(
  metadata: Record<string, string> | null | undefined,
): StripeSubscriptionKind {
  const kind = metadata?.[SUBSCRIPTION_KIND_METADATA_KEY];
  if (kind === undefined || kind === null || kind === '') return 'account_plan';
  if (kind === DEDICATED_SUBSCRIPTION_KIND) return 'published_app_dedicated';
  return 'unknown';
}

/**
 * Stripe statuses under which a dedicated subscription entitles its app to stay
 * always-on.
 *
 * DELIBERATELY WIDER THAN `ENTITLED_SUBSCRIPTION_STATUSES` in
 * `billing/subscription-tier-sync.ts`, and a separate constant rather than a
 * reuse, because the two answer different questions and the consequences of
 * getting them wrong point in opposite directions. Losing a plan feature for a
 * few days while a card is retried is an inconvenience; taking a customer's
 * PRODUCTION APP to scale-to-zero is an outage they did not cause and cannot
 * predict. So `past_due` keeps the app up.
 *
 * That is a real, bounded cost — we serve an always-on machine we have not been
 * paid for — and the bound is Stripe's dunning settings, which end a failing
 * subscription at `canceled` or `unpaid`. BOTH of those fall out of this set, so
 * the free ride ends when Stripe says the retries are over. THE BOUND IS
 * CONFIGURATION, NOT CODE: a Stripe account whose dunning is set to leave failed
 * subscriptions `past_due` indefinitely would serve a dedicated app forever for
 * free, and nothing in this repo can detect that. It is the one operator setting
 * this constant depends on.
 *
 * `incomplete` is absent, and that is the other half of the same care: a
 * subscription created but never paid for is how somebody would get an always-on
 * machine by starting a checkout and abandoning it.
 */
export const DEDICATED_ENTITLED_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

export function isDedicatedEntitled(status: string): boolean {
  return DEDICATED_ENTITLED_STATUSES.includes(status);
}

// ── Tier changes ─────────────────────────────────────────────────────────────

export type TierChangeRefusal =
  /** The app is already on the requested tier. */
  | 'same_tier'
  /** The app is being torn down, or has failed; a tier change would be writing to a corpse. */
  | 'terminal_status'
  /** The requested tier cannot run the app's current guest size. */
  | 'guest_preset_not_allowed';

/**
 * What a tier change has to do besides writing the column.
 *
 * `unpark` is the interesting one and it is the reason this is a plan rather than
 * a boolean. A `parked` app is one the credit gate refused, and
 * `published_apps_parked_is_metered_only` makes `parked` + `dedicated` an
 * unrepresentable row — so an upgrade FROM a parked metered app is not merely
 * allowed to un-park it, it MUST, in the same statement, or the database rejects
 * the write outright. That is exactly the behaviour the product wants (paying the
 * flat price is how you get an out-of-credits app serving again), and it is
 * pleasing that the constraint and the product agree; but the write has to be
 * built knowing it, because "set the tier, then fix the status" is two statements
 * and the first of them cannot commit.
 *
 * `stopped` rather than `running` because parking is not the same as being awake:
 * the app resumes through the ordinary wake path on its next request, exactly as
 * `PUBLISHED_APP_TRANSITIONS` allows (`parked -> stopped`, never `parked ->
 * running`).
 */
export type TierChangePlan =
  | { allowed: true; tier: PublishedAppTier; unpark: boolean; nextStatus: PublishedAppStatus }
  | { allowed: false; reason: TierChangeRefusal };

export interface TierChangeInput {
  from: PublishedAppTier;
  to: PublishedAppTier;
  status: PublishedAppStatus;
  guestPreset: string;
}

/**
 * Decide whether an app may move between tiers, and what the status must become.
 *
 * Never throws: a refusal is a value, because tier changes are user actions
 * racing crons and a refusal is an ordinary outcome.
 *
 * A DOWNGRADE off a bigger guest is refused rather than silently resized. Resizing
 * means destroying and recreating the machine (a guest change is a machine CREATE,
 * not an update — the rootfs assembles at create), so a downgrade that quietly did
 * it would take a serving app offline as a side effect of a billing action the
 * user thought was about money. The caller resizes first, then downgrades, and the
 * user sees both steps.
 */
export function planTierChange({ from, to, status, guestPreset }: TierChangeInput): TierChangePlan {
  if (from === to) return { allowed: false, reason: 'same_tier' };
  // `destroying` is terminal and `failed` re-enters the pipeline only through an
  // explicit provisioning retry; a tier written to either is a tier nothing will
  // ever act on, and for `destroying` it is a tier on a row that is about to be
  // deleted.
  if (status === 'destroying' || status === 'failed') {
    return { allowed: false, reason: 'terminal_status' };
  }
  if (!isGuestPresetAllowedForTier(guestPreset, to)) {
    return { allowed: false, reason: 'guest_preset_not_allowed' };
  }
  const unpark = status === 'parked';
  return { allowed: true, tier: to, unpark, nextStatus: unpark ? 'stopped' : status };
}

// ── Machine config ───────────────────────────────────────────────────────────

/** The result of merging a tier's always-on setting into a live machine config. */
export interface MinMachinesMergeResult {
  config: MachineConfig;
  /**
   * How many service entries were rewritten. ZERO is the case worth handling: a
   * machine with no `services` has no port bindings and is not receiving traffic,
   * so there is nowhere for `min_machines_running` to go and the caller has just
   * learned something is wrong with the machine rather than with the merge.
   */
  applied: number;
}

/**
 * Set `min_machines_running` on every service in a LIVE machine config, returning
 * the whole config for {@link updateMachineConfig} to send back.
 *
 * WHY THIS IS A MERGE AND NOT A CONFIG. Fly's machine update is a FULL REPLACE:
 * every field absent from the posted config is deleted from the machine, with a
 * 200 OK and no warning. Posting `{services: [...]}` alone would strip `image`,
 * `env`, `mounts`, `checks` and `metadata` off an app that is serving traffic
 * right now. So this takes the CURRENT config — the one `updateMachineConfig`
 * fetched — and returns it with one field changed, preserving unknown keys at both
 * levels through the spreads and through `MachineConfig`'s index signature.
 *
 * Non-object entries in `services` pass through untouched rather than being
 * coerced or dropped: `services` is typed `unknown[]` precisely because Fly owns
 * its shape, and an entry we do not understand is one we must return exactly as we
 * received it. It is also not counted in `applied`, so a config full of entries we
 * could not act on reports 0 rather than claiming success.
 *
 * A config with NO `services` key comes back unchanged (and `applied: 0`) rather
 * than acquiring an invented one: fabricating a service would tell Fly to start
 * routing traffic to a port this function has no way to know.
 */
export function applyMinMachinesRunning(
  current: MachineConfig,
  minMachinesRunning: number,
): MinMachinesMergeResult {
  const services = current.services;
  if (!Array.isArray(services)) return { config: { ...current }, applied: 0 };

  let applied = 0;
  const next = services.map((service) => {
    if (typeof service !== 'object' || service === null || Array.isArray(service)) return service;
    applied += 1;
    return { ...(service as Record<string, unknown>), min_machines_running: minMachinesRunning };
  });
  return { config: { ...current, services: next }, applied };
}
