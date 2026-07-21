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

/** Parse a non-negative float env override; fall back to `fallback` on absence/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Markup applied to real provider cost, in basis points. 15000 = 1.5×. */
export const MARKUP_BPS = envInt('CREDIT_MARKUP_BPS', 15000);

/**
 * Discount factor (basis points of the input rate) applied to CACHED input tokens in
 * the ESTIMATE fallback path (calculateCost). Providers bill cache reads at a small
 * fraction of the fresh-input rate (~10% is typical for Anthropic/OpenAI prompt
 * caching), so charging cached tokens at the full input rate would over-estimate.
 * Only affects the fallback estimate used when OpenRouter's authoritative cost is
 * absent (direct providers, or metadata dropped) — real provider cost already reflects
 * the provider's own cache pricing and is billed verbatim. 10000 = full rate (no
 * discount); default 1000 = 0.10×.
 */
export const CACHE_READ_DISCOUNT_FACTOR_BPS = envInt('CACHE_READ_DISCOUNT_FACTOR_BPS', 1000);

/**
 * Monthly credit allowance granted on each subscription renewal, per tier.
 * Accumulates across periods (rollover): each renewal ADDS this allowance to
 * the current balance rather than replacing it.
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
 * Flat per-call hold estimate for AI image generation. The real cost isn't known
 * until OpenRouter responds (it varies by image model and resolution), so the gate
 * reserves this approximate amount up front. A single image runs ~$0.05–0.10 real
 * provider cost (~$0.068 measured for Gemini Flash Image); at the 1.5× markup that
 * lands under ~15¢ of credit value, so 25¢ comfortably covers a worst-case single
 * image without over-reserving. It is an ESTIMATE, not a cap — the real cost settles
 * exactly via consumeCredits from OpenRouter's usage.cost. Tune via env.
 */
export const IMAGE_GEN_HOLD_ESTIMATE_CENTS = envInt('IMAGE_GEN_HOLD_ESTIMATE_CENTS', 25);

/**
 * Fallback per-image real cost (US dollars) used ONLY when OpenRouter does not return
 * an authoritative `usage.cost` for an image call (rare — measured calls DO return it).
 * A flat per-image number is correct here because image models bill per image, not per
 * token, so the token-based estimate table (AI_PRICING/calculateCost) does not apply.
 * When the real cost is present it is billed verbatim; this only bounds the no-cost path.
 */
export const IMAGE_GEN_FALLBACK_COST_DOLLARS = envFloat('IMAGE_GEN_FALLBACK_COST_DOLLARS', 0.05);

/** Provenance of a settled image cost — mirrors the `costSource` label on ai_usage_logs. */
export type ImageCostSource = 'openrouter' | 'estimate';

export interface ResolvedImageCost {
  /** Real provider cost in US dollars to settle the hold against. */
  costDollars: number;
  costSource: ImageCostSource;
}

/**
 * Pure: resolve the billable dollar cost for one image generation.
 * - Given OpenRouter's authoritative `usage.cost` (any finite number >= 0), bill it
 *   verbatim with `costSource: 'openrouter'`. ZERO is a real, authoritative price — free
 *   image models exist on OpenRouter — so it must NOT fall through to the estimate, which
 *   would charge for a free generation.
 * - Only when the cost is absent (undefined/null/non-finite) fall back to a flat per-image
 *   estimate with `costSource: 'estimate'`.
 * No I/O; `fallbackDollars` is injectable for tests.
 */
export function resolveImageCost(
  providerCostDollars: number | null | undefined,
  fallbackDollars: number = IMAGE_GEN_FALLBACK_COST_DOLLARS,
): ResolvedImageCost {
  if (typeof providerCostDollars === 'number' && Number.isFinite(providerCostDollars) && providerCostDollars >= 0) {
    return { costDollars: providerCostDollars, costSource: 'openrouter' };
  }
  return { costDollars: fallbackDollars, costSource: 'estimate' };
}

/**
 * Flat per-call hold estimate for a Machine run, where the active-window
 * duration — and therefore the real cost — isn't known until the run ends, so the
 * gate has nothing exact to reserve against (mirrors VOICE_HOLD_ESTIMATE_CENTS' STT
 * rationale). A short tool call or PTY burst costs a small fraction of a cent at the
 * assumed default machine shape, so 2¢ is a reasonable approximate reservation. The
 * real cost always settles exactly via consumeCredits and the 1.5× markup; concurrent
 * overdraw is bounded by MACHINE_MAX_INFLIGHT instead. Tune via env.
 */
export const MACHINE_HOLD_ESTIMATE_CENTS = envInt('MACHINE_HOLD_ESTIMATE_CENTS', 2);

/**
 * FLOOR for max concurrent in-flight Machine runs per payer — mirrors
 * VOICE_MAX_INFLIGHT, and bounds worst-case concurrent overdraw to
 * `MACHINE_MAX_INFLIGHT × the real settled cost of a single run`. Set to
 * match the top subscription tier's `quota.ts` concurrency ceiling (business,
 * 50) as a sane default, but `machine-billing.ts`'s `gate()` takes
 * `Math.max(MACHINE_MAX_INFLIGHT, that payer's own tier ceiling)` rather than
 * using this value alone — so if a tier's `quota.ts` limit is ever raised
 * past this default without also raising this env var, the billing gate
 * still tracks it instead of silently rejecting runs the semaphore would
 * allow. Default 50.
 */
export const MACHINE_MAX_INFLIGHT = envInt('MACHINE_MAX_INFLIGHT', 50);

/**
 * Absolute floor for {@link MACHINE_MARKUP_BPS} — 15000bps (1.5x). The whole
 * point of that constant is to GUARANTEE Machine billing never falls below
 * 1.5x real substrate cost, independent of {@link MARKUP_BPS}; an env
 * misconfiguration (typo, someone mirroring a reduced AI markup) must not be
 * able to silently violate that guarantee. Only a value BELOW this floor is
 * clamped up — a deliberately higher markup passes through unclamped, since
 * there is no stated ceiling.
 */
export const MACHINE_MARKUP_FLOOR_BPS = 15000;

/**
 * Markup applied to Machine substrate cost, in basis points — the
 * founder-set floor of 1.5× real substrate cost. Deliberately a SEPARATE env
 * var and constant from {@link MARKUP_BPS} (not derived from it): AI-model
 * pricing and substrate-runtime pricing are different economics that may
 * diverge, so lowering `CREDIT_MARKUP_BPS` for AI billing must never silently
 * lower what a Machine is charged. Threaded into `consumeCredits` via
 * `markupBpsOverride` (see machine-billing.ts's `trackUsage`) so the real
 * settle path enforces this floor independent of the shared default. Clamped
 * to {@link MACHINE_MARKUP_FLOOR_BPS} so a misconfigured env var can raise
 * the markup but never lower it below the documented floor.
 */
export const MACHINE_MARKUP_BPS = Math.max(
  envInt('MACHINE_MARKUP_BPS', MACHINE_MARKUP_FLOOR_BPS),
  MACHINE_MARKUP_FLOOR_BPS,
);

/**
 * Published Sprites rates, in USD per resource-hour (tasks/terminal.md: active
 * CPU-hour $0.07 + mem GB-hour $0.04375). Lives here (not machine-pricing.ts) so
 * every Machine-billing constant is env-overridable from one place, matching
 * every other pricing table in this file.
 */
export const MACHINE_RATES = {
  usdPerCpuHour: envFloat('MACHINE_USD_PER_CPU_HOUR', 0.07),
  usdPerMemGbHour: envFloat('MACHINE_USD_PER_MEM_GB_HOUR', 0.04375),
};

/**
 * Assumed default machine shape (vCPUs / RAM in GB) used to price active runtime,
 * since no per-run resource allocation is read back from Sprites (see
 * sandbox-options.ts's `SandboxResourceCaps`: `ramMB`/`cpus` are both optional,
 * unset -> provider default). Env-overridable so this can track Sprites' real
 * default shape without a deploy.
 */
export const MACHINE_ASSUMED_CPUS = envFloat('MACHINE_ASSUMED_CPUS', 1);
export const MACHINE_ASSUMED_MEMORY_GB = envFloat('MACHINE_ASSUMED_MEMORY_GB', 0.25);

/**
 * Assumed persistent-storage rate, in USD per GB-month, for a Machine's persistent
 * filesystem (the thing that survives hibernation). The platform bills for the
 * bytes actually WRITTEN (TRIM-friendly — deleting files lowers the bill), not
 * the provisioned volume size (docs.sprites.dev/concepts/lifecycle), so the
 * quantity this rate multiplies is the machine's MEASURED footprint in GB-months
 * (see machine-storage-reconcile.ts), not its allocation. The HOT (NVMe cache)
 * and COLD (durable object store) layers underneath the filesystem are infra,
 * not separately-billed tiers — a single used-bytes figure is the right
 * quantity; a per-tier split, if the API ever exposes one, is a follow-up.
 * Placeholder pending Sprites' published storage rate; tune via env once confirmed.
 */
export const MACHINE_STORAGE_USD_PER_GB_MONTH = envFloat('MACHINE_STORAGE_USD_PER_GB_MONTH', 0.15);

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
 * overdraw to `MAX_CHAT_INFLIGHT × the real settled cost of a single chat call` (the
 * hold only bounds the up-front reservation, not the final settle, so the cap — not the
 * hold — is what limits how far simultaneous calls can collectively run past the
 * balance before any settles). Generous enough for legitimate multi-tab / multi-agent
 * use. Default 8.
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

/**
 * Per-user/day charged-spend ceiling, in whole cents — a runaway-spend backstop layered
 * on top of the credit-balance gate (a looping agent can stay within the in-flight cap
 * yet rack up real cost over a day). Resolved per tier: `DAILY_CAP_<TIER>_CENTS` (e.g.
 * `DAILY_CAP_BUSINESS_CENTS`) overrides the global `DAILY_USER_EXPOSURE_CAP_CENTS`; both
 * default to 0 = DISABLED (returns null → always allowed). Read at CALL TIME so it
 * toggles via env without a code change and tests can set it per-case.
 */
export function dailyExposureCapForTier(tier: SubscriptionTier): number | null {
  const globalCap = envInt('DAILY_USER_EXPOSURE_CAP_CENTS', 0);
  const cap = envInt(`DAILY_CAP_${tier.toUpperCase()}_CENTS`, globalCap);
  return cap > 0 ? cap : null;
}

/**
 * Per-user/day ceiling (whole cents) on the day's charged spend, enforced when a run
 * is forced by a possessed page-webhook secret rather than an authenticated user.
 * Unlike the tier caps above — which default to 0 = DISABLED — this defaults ON:
 * the webhook secret is a bearer credential handed to external systems, so an
 * unconfigured deployment must still have a hard monetary bound on what a leaked
 * secret can spend. Passed as `dailyCapCeilingCents` to canConsumeAI (effective cap =
 * min with any configured tier cap). 0 disables (not recommended). Default $5/day.
 */
export const WEBHOOK_DAILY_EXPOSURE_CAP_CENTS = envInt('WEBHOOK_DAILY_EXPOSURE_CAP_CENTS', 500);

/**
 * Tolerances for the async OpenRouter cost reconcile (cost-reconcile.ts). A correction
 * fires only when the |drift| between billed and authoritative /generation cost exceeds
 * BOTH the absolute floor and the relative band — so sub-cent noise never churns the
 * ledger. Defaults: 1¢ floor, 5% band.
 */
export const COST_RECONCILE_TOLERANCE_CENTS = envInt('COST_RECONCILE_TOLERANCE_CENTS', 1);
export const COST_RECONCILE_TOLERANCE_BPS = envInt('COST_RECONCILE_TOLERANCE_BPS', 500);

/**
 * Max times the reconcile cron re-fetches a row's /generation cost before giving up and
 * marking it 'unavailable' (OpenRouter never resolved the generation). Bounds the retry
 * fan-out for permanently-missing generations. Default 6.
 */
export const COST_RECONCILE_MAX_ATTEMPTS = envInt('COST_RECONCILE_MAX_ATTEMPTS', 6);

/**
 * Base URL for the OpenRouter API. Defaults to production; OPENROUTER_BASE_URL redirects
 * it at a deterministic stub in e2e so the /generation reconcile can be asserted without
 * hitting the real API (mirrors the provider-factory override). Read at call time.
 */
export function openRouterBaseUrl(): string {
  return process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
}

/**
 * Tolerance (whole cents) for the account-level balance-drift detector: a user's
 * materialized buckets may diverge from the ledger-implied amount beyond this before the
 * admin panel flags them. Generous because monthly resets / debt-forgiveness legitimately
 * break exact reconciliation (see computeBalanceDrift). Default 10¢.
 */
export const BALANCE_DRIFT_TOLERANCE_CENTS = envInt('BALANCE_DRIFT_TOLERANCE_CENTS', 10);

/**
 * Margin floor (basis points) for the negative-margin account detector: charged credits
 * must cover real cost × (1 + floor). 0 = charged must at least equal real cost; a
 * positive value demands headroom. Default 0.
 */
export const NEGATIVE_MARGIN_FLOOR_BPS = envInt('NEGATIVE_MARGIN_FLOOR_BPS', 0);

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

/**
 * Bounds (whole cents) for a CUSTOM top-up amount, alongside the fixed packs. The min
 * keeps dust purchases above Stripe's per-transaction fee; the max caps single-charge
 * fraud/chargeback exposure. Validated by `validateTopupAmountCents` in credit-core,
 * shared by the checkout route and the client. Default $5–$500; tune via env.
 */
export const CREDIT_TOPUP_MIN_CENTS = envInt('CREDIT_TOPUP_MIN_CENTS', 500);
export const CREDIT_TOPUP_MAX_CENTS = envInt('CREDIT_TOPUP_MAX_CENTS', 50000);
