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
