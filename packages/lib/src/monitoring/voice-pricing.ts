/**
 * voice-pricing — real provider cost for voice (STT/TTS) calls.
 *
 * Voice does NOT go through OpenRouter, and OpenAI's audio endpoints return no
 * per-call cost or token figure (Whisper `verbose_json` gives the exact audio
 * `duration`; TTS returns only audio bytes). So there is no live provider-returned
 * cost to read back the way chat does via `extractOpenRouterCostDollars`.
 *
 * Instead the billable cost is computed DETERMINISTICALLY as
 *   exact billed quantity × OpenAI's published unit rate
 * — Whisper: audio seconds × per-minute rate (prorated to the second); TTS: input
 * characters × per-char rate. Both quantities are exact and both rates are fixed,
 * so `quantity × rate` equals what OpenAI bills us. This is real cost, not a
 * probabilistic estimate.
 *
 * The returned value is PRE-markup. Callers hand it to `AIMonitoring.trackUsage`
 * as `providerCostDollars`, and the credit pipeline applies the same 1.5× markup
 * (`MARKUP_BPS`) as every other AI call — that markup is also the buffer that
 * keeps us solvent if OpenAI's real rate ever drifts above this table (we'd only
 * front cost on a >50% price hike). Keeping a rate current is a one-line change.
 *
 * Rates are env-overridable so the founder can track an OpenAI price change without
 * a deploy. Defaults pinned to OpenAI's published audio pricing (see the unit test).
 *
 * The REALTIME section at the bottom of this file prices the audio-native path
 * (`gpt-realtime`), which bills TOKENS per modality rather than seconds/characters.
 * It is additive: the whisper/tts rates and behaviour above are untouched, because
 * on-demand TTS (Read Aloud) is a separate feature that is NOT being retired.
 */

import { MARKUP_BPS } from '../billing/credit-pricing';

/** Parse a non-negative float env override; fall back to `fallback` on absence/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type VoiceModel = 'whisper-1' | 'tts-1' | 'tts-1-hd';

/**
 * Published OpenAI audio rates, in USD per base unit:
 *   - STT (whisper-1): USD per audio SECOND (= $0.006 / minute ÷ 60).
 *   - TTS (tts-1 / tts-1-hd): USD per input CHARACTER ($15 / $30 per 1M chars).
 */
export const VOICE_RATES = {
  'whisper-1': { usdPerSecond: envFloat('VOICE_WHISPER_USD_PER_SECOND', 0.006 / 60) },
  'tts-1': { usdPerChar: envFloat('VOICE_TTS1_USD_PER_CHAR', 15 / 1_000_000) },
  'tts-1-hd': { usdPerChar: envFloat('VOICE_TTS1_HD_USD_PER_CHAR', 30 / 1_000_000) },
} as const;

export interface VoiceUsageQuantity {
  /** Audio duration in seconds (STT / whisper-1). */
  seconds?: number;
  /** Input character count (TTS / tts-1, tts-1-hd). */
  chars?: number;
}

/**
 * Real provider cost (USD, pre-markup) for one voice call. Returns 0 for an
 * unknown model or a missing/invalid quantity — never a negative or NaN charge,
 * so a malformed call is billed nothing rather than corrupting the ledger. The
 * routes only pass validated models, so 0 here means "nothing to bill".
 */
export function calculateVoiceCostDollars(model: string, quantity: VoiceUsageQuantity): number {
  if (model === 'whisper-1') {
    const seconds = quantity.seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
    return Number((seconds * VOICE_RATES['whisper-1'].usdPerSecond).toFixed(6));
  }

  if (model === 'tts-1' || model === 'tts-1-hd') {
    const chars = quantity.chars;
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return 0;
    return Number((chars * VOICE_RATES[model].usdPerChar).toFixed(6));
  }

  return 0;
}

/**
 * Charged-credit reservation (whole cents, minimum 1) for a voice call whose
 * billable quantity is already known — i.e. TTS, where the input character count is
 * in hand before the provider call. Reserves exactly what the call will be charged
 * (real cost × markup), so the gate's spendable-floor check is accurate per call
 * instead of relying on a flat estimate that a long TTS request would blow past.
 * STT can't use this (audio duration is unknown until the provider responds) and
 * falls back to the flat VOICE_HOLD_ESTIMATE_CENTS.
 */
export function estimateVoiceHoldCents(model: string, quantity: VoiceUsageQuantity): number {
  const charged = calculateVoiceCostDollars(model, quantity) * (MARKUP_BPS / 10_000) * 100;
  if (!Number.isFinite(charged) || charged <= 0) return 1;
  return Math.max(1, Math.ceil(charged));
}

/* ------------------------------------------------------------------------- *
 * REALTIME (audio-native) — token-metered, per modality.
 *
 * The STT/TTS path above bills a quantity we choose (seconds we uploaded,
 * characters we sent). The realtime API instead REPORTS what it billed, as a
 * `usage` object on every `response.done` — so here the exact quantity comes
 * off the wire and this table only supplies the rate. Still deterministic,
 * still real cost rather than an estimate.
 *
 * Three asymmetries in that wire shape are load-bearing and are modelled, not
 * smoothed over:
 *   1. Caching is INPUT-ONLY. There is no cached figure on the output side, so
 *      the output rate type has no `cached` member to fill in wrongly.
 *   2. `cached_tokens` is a SUBSET of `input_tokens`, not an addition. Cached
 *      tokens are billed at the cached rate and only the REMAINDER at the full
 *      input rate — billing both would double-count every cache hit.
 *   3. Modality is the cost driver, not volume: one short spoken sentence
 *      measured 30 text + 86 audio output tokens, and audio output is ~2.7x the
 *      text rate. A single blended total would hide that entirely, so input and
 *      output are each priced per modality and summed.
 *
 * Like the audio rates above this returns PRE-markup cost and is env-overridable
 * per rate, so an OpenAI price change is an env change rather than a deploy.
 * ------------------------------------------------------------------------- */

/**
 * Realtime models we can price. Deliberately a closed union: `OPENAI_REALTIME_MODEL`
 * can point the app at a newer realtime model, but a model with no row here prices
 * at 0 rather than being billed at another model's rates — so bumping that env var
 * means adding its published rates here in the same change.
 *
 * `gpt-realtime-2.1` is the DEFAULT the app now pins (`DEFAULT_REALTIME_MODEL`), and it
 * had to be added here in the same change that made the server meter a live call: an
 * unpriced default is not a conservative default, it is a call that bills nothing.
 * (The earlier note here said 2.1 was entitled but not served over WebRTC —
 * `POST /v1/realtime/calls` answered `403 model_not_found`. That was true of the
 * ACCOUNT, not the transport: once the project allowlisted 2.1 the same endpoint
 * returned 201 for a real browser SDP offer.)
 *
 * `gpt-realtime-2.1-mini` is deliberately absent. It exists and `/v1/models` lists it,
 * but only its audio rates are published in a form worth copying, and half a rate table
 * bills wrongly in a direction nobody notices. Pointing `OPENAI_REALTIME_MODEL` at it
 * means adding its verified rates here in the same change — which is exactly the rule
 * this closed union exists to enforce.
 */
export type RealtimeModel = 'gpt-realtime' | 'gpt-realtime-2.1';

/** USD per token for each input modality. */
export interface RealtimeInputRates {
  text: number;
  audio: number;
  image: number;
}

/**
 * USD per token for each output modality. No `image` (the model does not emit
 * images) and no cached variant (see asymmetry 1 above) — the type refuses to
 * describe a price that does not exist.
 */
export interface RealtimeOutputRates {
  text: number;
  audio: number;
}

export interface RealtimeModelRates {
  input: RealtimeInputRates;
  /** Cache-read rate, charged on the cached SUBSET of the input tokens. */
  cachedInput: RealtimeInputRates;
  output: RealtimeOutputRates;
}

/**
 * Published `gpt-realtime` rates, in USD per TOKEN (OpenAI publishes per 1M):
 *
 *          input    cached input    output
 *   text     $4         $0.40        $24
 *   audio   $32         $0.40        $64
 *   image    $5         $0.50          —
 */
const publishedRates = (): RealtimeModelRates => ({
  input: {
    text: envFloat('REALTIME_INPUT_TEXT_USD_PER_TOKEN', 4 / 1_000_000),
    audio: envFloat('REALTIME_INPUT_AUDIO_USD_PER_TOKEN', 32 / 1_000_000),
    image: envFloat('REALTIME_INPUT_IMAGE_USD_PER_TOKEN', 5 / 1_000_000),
  },
  cachedInput: {
    text: envFloat('REALTIME_CACHED_INPUT_TEXT_USD_PER_TOKEN', 0.4 / 1_000_000),
    audio: envFloat('REALTIME_CACHED_INPUT_AUDIO_USD_PER_TOKEN', 0.4 / 1_000_000),
    image: envFloat('REALTIME_CACHED_INPUT_IMAGE_USD_PER_TOKEN', 0.5 / 1_000_000),
  },
  output: {
    text: envFloat('REALTIME_OUTPUT_TEXT_USD_PER_TOKEN', 24 / 1_000_000),
    audio: envFloat('REALTIME_OUTPUT_AUDIO_USD_PER_TOKEN', 64 / 1_000_000),
  },
});

/**
 * `gpt-realtime` and `gpt-realtime-2.1` publish the SAME rate card, verified
 * against each model's own pricing table rather than assumed from the family
 * name — so they share one builder and one set of env overrides instead of two
 * copies that could be edited apart. A future model whose rates diverge gets
 * its own literal here; that is the point at which the env vars need splitting,
 * and not before.
 */
export const REALTIME_RATES: Record<RealtimeModel, RealtimeModelRates> = {
  'gpt-realtime': publishedRates(),
  'gpt-realtime-2.1': publishedRates(),
};

/** Per-modality breakdown of the cached SUBSET of input tokens. */
export interface RealtimeCachedTokenDetails {
  text_tokens?: number;
  audio_tokens?: number;
  image_tokens?: number;
}

/** `usage.input_token_details` as it arrives on the wire. */
export interface RealtimeInputTokenDetails extends RealtimeCachedTokenDetails {
  /** Cached tokens — a SUBSET of `input_tokens`, already counted in the modality fields. */
  cached_tokens?: number;
  cached_tokens_details?: RealtimeCachedTokenDetails;
}

/** `usage.output_token_details` — no image, no cache (see asymmetry 1). */
export interface RealtimeOutputTokenDetails {
  text_tokens?: number;
  audio_tokens?: number;
}

/**
 * The `usage` object carried on every realtime `response.done`. Usage is per
 * RESPONSE, not per call, so a session's cost is the sum over its responses —
 * every field is optional because it comes off the wire and none of it is ours.
 */
export interface RealtimeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: RealtimeInputTokenDetails;
  output_token_details?: RealtimeOutputTokenDetails;
}

/** Sanitize one wire token count: anything not a finite, non-negative number counts as 0. */
function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Sanitized token counts per input modality. Structurally identical to
 * {@link RealtimeInputRates} but a distinct name, so a reader is never left
 * wondering whether a given triple holds dollars or tokens.
 */
interface RealtimeInputTokens {
  text: number;
  audio: number;
  image: number;
}

/**
 * How many of each modality's input tokens were cache reads.
 *
 * Preferred source is `cached_tokens_details`, which splits the cached subset by
 * modality directly; each modality is clamped to its own gross count so a
 * malformed payload can never make the fresh remainder negative (which would
 * subtract money from the bill).
 *
 * If that block is absent but a `cached_tokens` TOTAL is reported, the total is
 * apportioned across modalities in proportion to their share of the input. The
 * approximation is cheap to be wrong about: cached text and cached audio are the
 * same rate ($0.40/1M), so the split only matters for the image slice, and
 * ignoring the reported total instead would over-bill the customer for tokens
 * OpenAI charged us a tenth of a cent for.
 */
function resolveCachedInputTokens(
  details: RealtimeInputTokenDetails,
  gross: RealtimeInputTokens,
): RealtimeInputTokens {
  const split = details.cached_tokens_details;
  const detailed = {
    text: tokenCount(split?.text_tokens),
    audio: tokenCount(split?.audio_tokens),
    image: tokenCount(split?.image_tokens),
  };

  if (detailed.text + detailed.audio + detailed.image > 0) {
    return {
      text: Math.min(detailed.text, gross.text),
      audio: Math.min(detailed.audio, gross.audio),
      image: Math.min(detailed.image, gross.image),
    };
  }

  const reported = tokenCount(details.cached_tokens);
  const grossTotal = gross.text + gross.audio + gross.image;
  if (reported <= 0 || grossTotal <= 0) return { text: 0, audio: 0, image: 0 };

  // min() keeps the share at or below 1, so no modality's cached slice can
  // exceed its gross count even if the reported total overshoots the details.
  const share = Math.min(reported, grossTotal) / grossTotal;
  return { text: gross.text * share, audio: gross.audio * share, image: gross.image * share };
}

/**
 * Real provider cost (USD, pre-markup) for ONE realtime response's `usage` object.
 * A call's total is the sum across its responses, accumulated by whatever holds the
 * server socket open for the session's lifetime.
 *
 * Returns 0 for an unknown model, absent usage, or quantities that are missing,
 * negative or NaN — never a negative or NaN charge, so a malformed frame is billed
 * nothing rather than corrupting the ledger.
 *
 * Cost is built strictly from the per-modality detail blocks; the `input_tokens` /
 * `output_tokens` totals are deliberately NOT used as a fallback. A total with no
 * modality attached cannot be priced (audio input costs 8x text input), and guessing
 * a modality would over-charge the customer half the time — so an unattributed total
 * bills 0 and the metering layer, which can see the whole session, is the right place
 * to notice a payload that shape.
 */
export function calculateRealtimeCostDollars(
  model: string,
  usage: RealtimeUsage | null | undefined,
): number {
  const rates: RealtimeModelRates | undefined = REALTIME_RATES[model as RealtimeModel];
  if (!rates || !usage) return 0;

  let dollars = 0;

  const input = usage.input_token_details;
  if (input) {
    const gross: RealtimeInputTokens = {
      text: tokenCount(input.text_tokens),
      audio: tokenCount(input.audio_tokens),
      image: tokenCount(input.image_tokens),
    };
    const cached = resolveCachedInputTokens(input, gross);
    // Cached at the cache-read rate, the REMAINDER at the full input rate —
    // never both for the same token (see asymmetry 2).
    dollars +=
      cached.text * rates.cachedInput.text + (gross.text - cached.text) * rates.input.text;
    dollars +=
      cached.audio * rates.cachedInput.audio + (gross.audio - cached.audio) * rates.input.audio;
    dollars +=
      cached.image * rates.cachedInput.image + (gross.image - cached.image) * rates.input.image;
  }

  const output = usage.output_token_details;
  if (output) {
    dollars += tokenCount(output.text_tokens) * rates.output.text;
    dollars += tokenCount(output.audio_tokens) * rates.output.audio;
  }

  return Number(dollars.toFixed(6));
}
