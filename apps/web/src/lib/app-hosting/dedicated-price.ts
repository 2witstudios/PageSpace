/**
 * dedicated-price — which Stripe price sells which guest size, and the floor
 * below which we refuse to sell it.
 *
 * WHY THESE ARE ENV VARS AND NOT `stripe-config.ts`. That file hardcodes the
 * account-plan price ids for a specific reason stated in its own header: they are
 * `NEXT_PUBLIC` values that Next.js has to inline at build time, and they end up
 * in the client bundle anyway. The dedicated prices are the opposite on both
 * counts — the subscription is created server-side and no price id is ever sent to
 * a browser — and there is one per guest size rather than one per plan. Reading
 * them from the server environment means the SKU can be switched on by creating
 * prices in Stripe and setting env, with no code change and no rebuild, which is
 * exactly what "ships dark" needs.
 *
 * FAIL CLOSED, in the same shape as `resolveFlyMachinesToken()`: an unconfigured
 * preset yields null and the caller refuses the purchase BEFORE any Stripe call.
 * A deployment that has not been given prices cannot accidentally sell at one.
 */

import { stripe } from '@/lib/stripe';
import {
  dedicatedMonthlyFloorCents,
  findGuestPreset,
} from '@pagespace/lib/services/app-hosting/dedicated-tier';

/**
 * The env var carrying a preset's Stripe price id.
 *
 * Derived from the preset name rather than listed, so adding a size to the
 * catalogue cannot leave a price lookup silently pointing at nothing: the
 * variable's name follows the preset's, and a missing one is reported by name in
 * the refusal.
 */
export function dedicatedPriceEnvVar(guestPreset: string): string {
  return `DEDICATED_PRICE_ID_${guestPreset.toUpperCase().replace(/-/g, '_')}`;
}

/** The configured Stripe price id for a preset, or null when unset/blank. */
export function resolveDedicatedPriceId(guestPreset: string): string | null {
  const configured = process.env[dedicatedPriceEnvVar(guestPreset)];
  return configured && configured.trim().length > 0 ? configured.trim() : null;
}

export type DedicatedPriceRefusal =
  /** The preset is not in the catalogue at all. */
  | 'unknown_preset'
  /** No price id is configured for this preset on this deployment. */
  | 'price_not_configured'
  /** Stripe does not recognise the configured id, or would not return it. */
  | 'price_not_found'
  /** The price is inactive, one-off, not monthly, or not in USD. */
  | 'price_not_monthly_usd'
  /** The price is below 1.5x the substrate cost of the guest it sells. */
  | 'price_below_floor';

export type DedicatedPriceCheck =
  | { ok: true; priceId: string; unitAmountCents: number; floorCents: number }
  | { ok: false; reason: DedicatedPriceRefusal; floorCents: number; unitAmountCents?: number };

/**
 * Resolve and VALIDATE the price that sells this guest size.
 *
 * The validation is the point, and it is what makes `MACHINE_MARKUP_BPS` bind on a
 * flat SKU at all. A metered app's markup is enforced every time `consumeCredits`
 * settles; a dedicated app's price is typed into a Stripe dashboard by a person,
 * and nothing else in the system would ever look at it again. So it is checked
 * once, at the moment of sale, against the same constants the metered tier is
 * priced from:
 *
 *   - MONTHLY and RECURRING, because the floor is a per-month figure. A one-off
 *     price or an annual one compared against a monthly floor is not a comparison,
 *     it is a category error that happens to typecheck.
 *   - USD, for the same reason: the floor is denominated in US cents, and
 *     comparing it to an amount in another currency silently sells at whatever the
 *     exchange rate happens to be.
 *   - ACTIVE, because an archived price still resolves and still cannot be
 *     subscribed to — better a named refusal than a Stripe error at create time.
 *   - AT OR ABOVE the floor. See `calculateDedicatedMonthlyFloorCents` for what
 *     the floor is and its important caveat: it is derived from the Sprites rate
 *     table, which is generous, so a refusal here is more likely to mean "these
 *     constants do not suit a hosting product" than "somebody mispriced it". It
 *     refuses either way — a floor that warned would not be a floor.
 *
 * `tiers` is not consulted here: whether a preset may be run at all on a given
 * tier is `isGuestPresetAllowedForTier`'s question, asked by the caller before it
 * gets this far. This function answers only "what does it cost and may we sell it
 * at that".
 */
export async function checkDedicatedPrice(guestPreset: string): Promise<DedicatedPriceCheck> {
  const preset = findGuestPreset(guestPreset);
  if (!preset) return { ok: false, reason: 'unknown_preset', floorCents: 0 };

  const floorCents = dedicatedMonthlyFloorCents(guestPreset);
  const priceId = resolveDedicatedPriceId(guestPreset);
  if (!priceId) return { ok: false, reason: 'price_not_configured', floorCents };

  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch {
    // The id is configured but Stripe will not return it — a typo, a price from
    // another account, or test/live mode crossed. Named rather than rethrown: the
    // caller's answer is the same as for an unconfigured price (refuse, change no
    // state), and an exception here would surface as a 500 on a misconfiguration.
    return { ok: false, reason: 'price_not_found', floorCents };
  }

  const recurring = price.recurring;
  const monthly =
    price.active &&
    price.currency === 'usd' &&
    recurring != null &&
    recurring.interval === 'month' &&
    recurring.interval_count === 1;
  if (!monthly) return { ok: false, reason: 'price_not_monthly_usd', floorCents };

  // A price with no `unit_amount` is tiered or metered — Stripe leaves the field
  // null and puts the money in `tiers`. There is no single figure to compare
  // against a floor, so it cannot clear one. Folded into the same refusal as a
  // genuinely-too-cheap price because the caller's action is identical.
  const unitAmountCents = price.unit_amount;
  if (unitAmountCents == null || unitAmountCents < floorCents) {
    return {
      ok: false,
      reason: 'price_below_floor',
      floorCents,
      ...(unitAmountCents == null ? {} : { unitAmountCents }),
    };
  }

  return { ok: true, priceId, unitAmountCents, floorCents };
}
