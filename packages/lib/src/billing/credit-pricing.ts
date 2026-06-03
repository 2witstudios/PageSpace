/**
 * credit-pricing — configuration for prepaid AI-credits billing.
 *
 * These constants/tables are passed INTO the pure functions in credit-core; the
 * core never imports this module. Env overrides let the founder tune economics
 * without a code change. All monetary values are whole cents of customer-facing
 * credit value. Placeholder defaults — final numbers TBD at kickoff.
 */

import type { SubscriptionTier } from '../services/subscription-utils';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  // Strict: only an unsigned integer literal overrides the default. Rejects
  // trailing junk ("100abc"), decimals ("1.5"), and signs so a typo'd billing
  // env var falls back to the safe default instead of silently parsing.
  if (!/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return fallback; // unrecognized value -> safe default
}

/**
 * Whether the prepaid credit gate actually BLOCKS out-of-credits / over-in-flight-cap
 * requests. Default OFF — the gate is dark-launched: it still does all its bookkeeping
 * and `consumeCredits` still records real cost + charged credits for unit-economics
 * observability, but the gate never returns a 402/429. This lets the cutover SHIP
 * (meter + observe) without surprising users, then flip enforcement on deliberately
 * once the placeholder allowances are validated against real spend:
 *   CREDITS_ENFORCEMENT_ENABLED=true
 * Read at CALL TIME (not module load) so it toggles via an env change + redeploy with
 * no code change, and so tests can set it per-case.
 */
export function isCreditsEnforcementEnabled(): boolean {
  return envBool('CREDITS_ENFORCEMENT_ENABLED', false);
}

/**
 * The ONE per-environment switch that selects the whole AI-usage experience, aliasing
 * the enforcement flag so the same image runs two ways by env alone:
 *   ON  → credits UI + credits enforcement (the new prepaid model).
 *   OFF → legacy daily-quota UI + the old per-call daily-limit path (prod stays "the old
 *         way"); credit metering still runs in the background for observability.
 * Drives: the AI-route limiter choice, the navbar widget, settings copy, and error copy.
 * Same env flag as enforcement on purpose — one lever flips presentation AND behaviour.
 */
export function isCreditsModeEnabled(): boolean {
  return isCreditsEnforcementEnabled();
}

/** Markup applied to real provider cost, in basis points. 15000 = 1.5×. */
export const MARKUP_BPS = envInt('CREDIT_MARKUP_BPS', 15000);

/**
 * Monthly credit allowance granted on each subscription renewal, per tier.
 * Resets every period (use-it-or-lose-it).
 */
export const TIER_MONTHLY_ALLOWANCE_CENTS: Record<SubscriptionTier, number> = {
  // Free: generous $5/mo of credit value, but the free-tier-only premium gate
  // (requiresProSubscription) confines it to cheaper "standard" models, so the
  // real provider cost behind that $5 stays low.
  free: envInt('CREDIT_ALLOWANCE_FREE_CENTS', 500),
  pro: envInt('CREDIT_ALLOWANCE_PRO_CENTS', 1500),
  founder: envInt('CREDIT_ALLOWANCE_FOUNDER_CENTS', 5000),
  business: envInt('CREDIT_ALLOWANCE_BUSINESS_CENTS', 10000),
};

/**
 * Block AI when spendable credits are at or below this floor. Bounds the single
 * in-flight call that can overshoot zero: the gate runs BEFORE a call but the real
 * cost is only known AFTER the stream, so the gate can wave through one call that
 * then exceeds the remaining balance. With the floor at 0 that overshoot is the
 * full cost of the most expensive single call — uncovered and (pre-fix) discarded.
 *
 * The default of 25¢ covers a plausible worst-case single completion: a long,
 * high-token answer from a premium model can run a few cents of real provider cost,
 * and at the 1.5× markup that lands around ~25¢ of customer-facing credit value.
 * So once spendable drops to the floor we stop, and the most we ever front on the
 * one call already in flight is bounded by it. Tune via env per real usage data.
 */
export const RESERVE_FLOOR_CENTS = envInt('CREDIT_RESERVE_FLOOR_CENTS', 25);

/**
 * Estimated spend reserved per in-flight call as a credit_holds row. The gate
 * subtracts the sum of a user's active holds from spendable, so concurrent calls
 * can't collectively overshoot the balance before any of them settles. Defaults
 * to the reserve floor — a plausible worst-case single completion (see
 * {@link RESERVE_FLOOR_CENTS}). Tune via env per real usage data.
 */
export const CREDIT_HOLD_ESTIMATE_CENTS = envInt('CREDIT_HOLD_ESTIMATE_CENTS', RESERVE_FLOOR_CENTS);

/**
 * Flat per-call hold estimate for voice STT (Whisper), where the audio duration —
 * and therefore the real cost — isn't known until the provider responds, so the gate
 * has nothing exact to reserve against. A short voice-mode clip costs a fraction of a
 * cent ($0.006/min × 1.5), so 2¢ is a reasonable approximate reservation that keeps
 * the spendable-floor check meaningful without over-reserving. It is an ESTIMATE, not
 * a guaranteed cap (a very long upload could exceed it); the real cost always settles
 * exactly via consumeCredits and the 1.5× markup — not this hold — is the solvency
 * guarantee. Because a single STT call can settle above this estimate, concurrent
 * paid-voice overdraw is bounded by VOICE_MAX_INFLIGHT (a per-user concurrency cap),
 * not by this reservation. TTS does NOT use this: its character count is known up
 * front, so it reserves the exact charged amount via estimateVoiceHoldCents(). Tune
 * via env.
 */
export const VOICE_HOLD_ESTIMATE_CENTS = envInt('VOICE_HOLD_ESTIMATE_CENTS', 2);

/**
 * Max concurrent in-flight VOICE calls per user, applied to ALL tiers (paid voice
 * is otherwise uncapped). Bounds worst-case concurrent overdraw: a hold reserves an
 * ESTIMATE, but the real cost only lands at settle, so without a cap a paid user
 * could open many simultaneous calls that each reserve little yet collectively
 * settle past their balance. STT especially can't reserve exactly (audio duration
 * is unknown until Whisper responds, and file size isn't a usable cost bound), so
 * this concurrency cap — not the per-call hold — is what bounds that exposure to
 * `VOICE_MAX_INFLIGHT × worst-case single call`. TTS already reserves its exact
 * charged amount. Voice mode plays chunks sequentially (≤2 in flight), so 4 is
 * comfortable for legitimate use. Default 4.
 */
export const VOICE_MAX_INFLIGHT = envInt('VOICE_MAX_INFLIGHT', 4);

/**
 * How long a hold lives before the reconcile cron may sweep it. Must exceed the
 * longest possible stream plus its settle window (AI routes cap streams at 300s),
 * so a still-running call's reservation is never reclaimed out from under it.
 * Default 15 minutes.
 */
export const CREDIT_HOLD_TTL_SECONDS = envInt('CREDIT_HOLD_TTL_SECONDS', 900);

/**
 * Max concurrent in-flight AI calls for a free-tier user. With daily call counts
 * gone, this bounds how many simultaneous streams one free user can open — each
 * of which could overshoot its reservation. Paid tiers are uncapped (bounded by
 * credits alone). Default 2.
 */
export const MAX_FREE_INFLIGHT = envInt('MAX_FREE_INFLIGHT', 2);

/**
 * Max concurrent in-flight CHAT calls per user, applied to ALL tiers. Mirrors
 * {@link VOICE_MAX_INFLIGHT}: a hold reserves only an ESTIMATE, but the real cost
 * lands at settle, so without a cap a user could open many simultaneous chats that
 * each reserve little yet collectively settle past their balance. This matters now
 * that the chat hold is a (smaller) model-aware estimate clamped to [floor, ceiling]
 * rather than the old flat 25¢ reserve floor — the cap bounds worst-case concurrent
 * overdraw to `MAX_CHAT_INFLIGHT × worst-case single chat call`. Generous enough for
 * legitimate multi-tab / multi-agent use. Default 8.
 */
export const MAX_CHAT_INFLIGHT = envInt('MAX_CHAT_INFLIGHT', 8);

/**
 * Lower bound (whole cents) for a model-aware chat hold, so a sub-cent call still
 * reserves something and the in-flight cap stays meaningful. Default 2¢.
 */
export const CHAT_HOLD_FLOOR_CENTS = envInt('CHAT_HOLD_FLOOR_CENTS', 2);

/**
 * Assumed per-call token budget used to size the model-aware chat hold BEFORE the call
 * runs (the real token counts aren't known until the stream finishes; the real cost
 * always settles exactly via consumeCredits regardless). Multiplied by the model's
 * catalog rate to get a pre-markup dollar estimate, then marked up and clamped to
 * [CHAT_HOLD_FLOOR_CENTS, RESERVE_FLOOR_CENTS]. Coarse on purpose — the clamp range,
 * not this budget, is the safety bound. Defaults ~4k in / 1k out (a typical chat turn).
 */
export const CHAT_HOLD_ASSUMED_INPUT_TOKENS = envInt('CHAT_HOLD_ASSUMED_INPUT_TOKENS', 4000);
export const CHAT_HOLD_ASSUMED_OUTPUT_TOKENS = envInt('CHAT_HOLD_ASSUMED_OUTPUT_TOKENS', 1000);

export interface CreditPack {
  /** Stable SKU id, also stored in Stripe price metadata. */
  id: string;
  /** Credit value added to the top-up bucket, in cents. */
  cents: number;
  /** Human label for the dashboard CTA. */
  label: string;
}

/** One-time top-up packs offered for purchase. */
export const CREDIT_PACKS: Record<string, CreditPack> = {
  pack_10: { id: 'pack_10', cents: 1000, label: '$10 credits' },
  pack_25: { id: 'pack_25', cents: 2500, label: '$25 credits' },
  pack_50: { id: 'pack_50', cents: 5000, label: '$50 credits' },
};

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS[id];
}
