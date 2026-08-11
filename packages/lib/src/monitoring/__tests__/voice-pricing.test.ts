import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateVoiceCostDollars,
  estimateVoiceHoldCents,
  VOICE_RATES,
  calculateRealtimeCostDollars,
  REALTIME_RATES,
  type RealtimeUsage,
} from '../voice-pricing';

describe('calculateVoiceCostDollars — Whisper STT', () => {
  it('bills 60s of audio at the published $0.006/min rate', () => {
    // 60 seconds = 1 minute = $0.006, exactly what OpenAI charges.
    expect(calculateVoiceCostDollars('whisper-1', { seconds: 60 })).toBeCloseTo(0.006, 6);
  });

  it('prorates partial seconds (30s → half a minute)', () => {
    expect(calculateVoiceCostDollars('whisper-1', { seconds: 30 })).toBeCloseTo(0.003, 6);
  });

  it('returns 0 for missing/invalid/zero duration rather than a NaN or negative charge', () => {
    expect(calculateVoiceCostDollars('whisper-1', {})).toBe(0);
    expect(calculateVoiceCostDollars('whisper-1', { seconds: 0 })).toBe(0);
    expect(calculateVoiceCostDollars('whisper-1', { seconds: -5 })).toBe(0);
    expect(calculateVoiceCostDollars('whisper-1', { seconds: Number.NaN })).toBe(0);
  });

  it('ignores a chars quantity for an STT model', () => {
    expect(calculateVoiceCostDollars('whisper-1', { chars: 1000 })).toBe(0);
  });
});

describe('calculateVoiceCostDollars — TTS', () => {
  it('bills tts-1 at $15 / 1M chars', () => {
    // 1000 chars × $15/1M = $0.015.
    expect(calculateVoiceCostDollars('tts-1', { chars: 1000 })).toBeCloseTo(0.015, 6);
  });

  it('bills tts-1-hd at $30 / 1M chars (double tts-1)', () => {
    expect(calculateVoiceCostDollars('tts-1-hd', { chars: 1000 })).toBeCloseTo(0.03, 6);
  });

  it('returns 0 for missing/invalid char counts', () => {
    expect(calculateVoiceCostDollars('tts-1', {})).toBe(0);
    expect(calculateVoiceCostDollars('tts-1', { chars: 0 })).toBe(0);
    expect(calculateVoiceCostDollars('tts-1-hd', { chars: -1 })).toBe(0);
  });
});

describe('calculateVoiceCostDollars — unknown model', () => {
  it('bills nothing (never corrupts the ledger) for an unrecognized model', () => {
    expect(calculateVoiceCostDollars('gpt-4o', { seconds: 100, chars: 100 })).toBe(0);
  });
});

describe('estimateVoiceHoldCents — reserves the exact charged amount for TTS', () => {
  // Default markup is 1.5× (MARKUP_BPS=15000).
  it('reserves the full worst-case max-length tts-1-hd call (~18¢), not a flat 2¢', () => {
    // 4096 chars × $30/1M = $0.12288 raw × 1.5 = $0.18432 → ceil to 19¢.
    expect(estimateVoiceHoldCents('tts-1-hd', { chars: 4096 })).toBe(19);
  });

  it('reserves a realistic ~1¢ for a typical sentence chunk', () => {
    // 200 chars × $15/1M = $0.003 raw × 1.5 = $0.0045 → ceil to 1¢.
    expect(estimateVoiceHoldCents('tts-1', { chars: 200 })).toBe(1);
  });

  it('never reserves below 1¢ (zero/unknown quantity still counts as one in-flight call)', () => {
    expect(estimateVoiceHoldCents('tts-1', { chars: 0 })).toBe(1);
    expect(estimateVoiceHoldCents('whisper-1', {})).toBe(1);
  });
});

describe('VOICE_RATES defaults pinned to OpenAI published audio pricing', () => {
  it('whisper-1 = $0.006/min', () => {
    expect(VOICE_RATES['whisper-1'].usdPerSecond).toBeCloseTo(0.006 / 60, 12);
  });
  it('tts-1 = $15/1M chars, tts-1-hd = $30/1M chars', () => {
    expect(VOICE_RATES['tts-1'].usdPerChar).toBeCloseTo(15 / 1_000_000, 12);
    expect(VOICE_RATES['tts-1-hd'].usdPerChar).toBeCloseTo(30 / 1_000_000, 12);
  });
});

/* ---------------------------------------------------------------- *
 * REALTIME (audio-native) token pricing
 * ---------------------------------------------------------------- */

/** The exact `usage` object measured off a live `response.done` frame. */
const MEASURED_USAGE: RealtimeUsage = {
  total_tokens: 168,
  input_tokens: 52,
  output_tokens: 116,
  input_token_details: {
    text_tokens: 11,
    audio_tokens: 41,
    image_tokens: 0,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 86 },
};

describe('REALTIME_RATES defaults pinned to OpenAI published gpt-realtime pricing', () => {
  const rates = REALTIME_RATES['gpt-realtime'];

  it('input = $4 text / $32 audio / $5 image per 1M tokens', () => {
    expect(rates.input.text).toBeCloseTo(4 / 1_000_000, 12);
    expect(rates.input.audio).toBeCloseTo(32 / 1_000_000, 12);
    expect(rates.input.image).toBeCloseTo(5 / 1_000_000, 12);
  });

  it('cached input = $0.40 text / $0.40 audio / $0.50 image per 1M tokens', () => {
    expect(rates.cachedInput.text).toBeCloseTo(0.4 / 1_000_000, 12);
    expect(rates.cachedInput.audio).toBeCloseTo(0.4 / 1_000_000, 12);
    expect(rates.cachedInput.image).toBeCloseTo(0.5 / 1_000_000, 12);
  });

  it('output = $24 text / $64 audio per 1M tokens', () => {
    expect(rates.output.text).toBeCloseTo(24 / 1_000_000, 12);
    expect(rates.output.audio).toBeCloseTo(64 / 1_000_000, 12);
  });

  it('models no cached or image rate on the OUTPUT side — caching is input-only', () => {
    // Asymmetry guard: if someone ever "symmetrizes" this table, this fails.
    expect(Object.keys(rates.output).sort()).toEqual(['audio', 'text']);
  });

  it('prices audio above text on both sides — per-modality metering is the whole point', () => {
    expect(rates.input.audio).toBeGreaterThan(rates.input.text);
    expect(rates.output.audio).toBeGreaterThan(rates.output.text);
  });
});

describe('calculateRealtimeCostDollars — the measured usage object', () => {
  it('sums the verbatim measured frame at published per-modality rates', () => {
    // in : 11 text x $4/1M     = 0.000044
    //      41 audio x $32/1M   = 0.001312
    //       0 image            = 0
    // out: 30 text x $24/1M    = 0.000720
    //      86 audio x $64/1M   = 0.005504
    //                    total = 0.007580
    expect(calculateRealtimeCostDollars('gpt-realtime', MEASURED_USAGE)).toBe(0.00758);
  });

  it('is dominated by audio OUTPUT — the cost driver a blended total would hide', () => {
    const audioOut = 86 * (64 / 1_000_000);
    expect(audioOut / 0.00758).toBeGreaterThan(0.7);
  });

  it('prices input alone when the output details are absent', () => {
    expect(
      calculateRealtimeCostDollars('gpt-realtime', {
        input_token_details: MEASURED_USAGE.input_token_details,
      }),
    ).toBe(0.001356);
  });

  it('prices output alone when the input details are absent', () => {
    expect(
      calculateRealtimeCostDollars('gpt-realtime', {
        output_token_details: MEASURED_USAGE.output_token_details,
      }),
    ).toBe(0.006224);
  });

  it('bills 0 for a usage object carrying only totals — an unattributed token has no price', () => {
    // input_tokens/output_tokens without a modality split cannot be priced (audio
    // input is 8x text input); guessing would over-charge, so it bills nothing.
    expect(
      calculateRealtimeCostDollars('gpt-realtime', {
        total_tokens: 168,
        input_tokens: 52,
        output_tokens: 116,
      }),
    ).toBe(0);
  });
});

describe('calculateRealtimeCostDollars — cached input is a SUBSET, never double counted', () => {
  it('bills the cached slice at the cached rate and the REMAINDER at the full input rate', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_tokens: 100,
      input_token_details: {
        audio_tokens: 100,
        cached_tokens: 40,
        cached_tokens_details: { audio_tokens: 40 },
      },
    });
    // 40 cached x $0.40/1M + 60 fresh x $32/1M = 0.000016 + 0.001920
    expect(cost).toBe(0.001936);
  });

  it('never bills the same token twice (the double-count guard)', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        audio_tokens: 100,
        cached_tokens: 40,
        cached_tokens_details: { audio_tokens: 40 },
      },
    });
    const allAtFullRate = 100 * (32 / 1_000_000); // 0.0032
    const doubleCounted = allAtFullRate + 40 * (0.4 / 1_000_000); // 0.003216
    const allAtCachedRate = 100 * (0.4 / 1_000_000); // 0.00004

    expect(cost).not.toBe(doubleCounted);
    expect(cost).toBeLessThan(allAtFullRate);
    expect(cost).toBeGreaterThan(allAtCachedRate);
  });

  it('clamps a cached count that overshoots its own modality, never going negative', () => {
    // Malformed: 500 cached audio tokens out of 100 total. Unclamped this would
    // make the fresh remainder -400 and subtract money from the bill.
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        audio_tokens: 100,
        cached_tokens: 500,
        cached_tokens_details: { audio_tokens: 500 },
      },
    });
    expect(cost).toBe(0.00004); // all 100 at the cached rate, floor'd there
    expect(cost).toBeGreaterThan(0);
  });

  it('prices image tokens, cached and fresh, at their own distinct rates', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        image_tokens: 1000,
        cached_tokens: 200,
        cached_tokens_details: { image_tokens: 200 },
      },
    });
    // 200 x $0.50/1M + 800 x $5/1M = 0.0001 + 0.004
    expect(cost).toBe(0.0041);
  });

  it('bills everything at the full rate when nothing is cached', () => {
    expect(
      calculateRealtimeCostDollars('gpt-realtime', {
        input_token_details: { audio_tokens: 100, cached_tokens: 0 },
      }),
    ).toBe(0.0032);
  });
});

describe('calculateRealtimeCostDollars — cached total with no modality breakdown', () => {
  it('apportions the reported cached total across modalities by input share', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: { text_tokens: 50, audio_tokens: 50, cached_tokens: 50 },
    });
    // share = 50/100 -> 25 cached + 25 fresh of each modality:
    // 25 x ($0.40 + $4 + $0.40 + $32)/1M = 25 x 36.8/1M
    expect(cost).toBe(0.00092);
  });

  it('caps the apportioned share at 1 when the reported total overshoots the input', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: { audio_tokens: 100, cached_tokens: 999 },
    });
    expect(cost).toBe(0.00004); // all 100 cached, none double counted
  });

  it('bills nothing when a cached total is reported against no input tokens at all', () => {
    expect(
      calculateRealtimeCostDollars('gpt-realtime', { input_token_details: { cached_tokens: 40 } }),
    ).toBe(0);
  });

  it('ignores an all-zero cached_tokens_details block and falls back to the reported total', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        audio_tokens: 100,
        cached_tokens: 100,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
      },
    });
    expect(cost).toBe(0.00004);
  });
});

describe('calculateRealtimeCostDollars — malformed input bills 0, never negative or NaN', () => {
  it('returns 0 for an unpriced model even with a fully valid usage object', () => {
    // Unpriced means billed 0, never billed at another model's rates. The mini
    // is the live example: `/v1/models` lists it and `OPENAI_REALTIME_MODEL`
    // could point at it, but only its audio rates are published in a form worth
    // copying — and half a rate table bills wrongly in a direction nobody
    // notices. Adding it means adding VERIFIED rates in the same change.
    expect(calculateRealtimeCostDollars('gpt-realtime-2.1-mini', MEASURED_USAGE)).toBe(0);
    expect(calculateRealtimeCostDollars('whisper-1', MEASURED_USAGE)).toBe(0);
    expect(calculateRealtimeCostDollars('', MEASURED_USAGE)).toBe(0);
  });

  it('prices gpt-realtime-2.1 — the model the app actually pins — rather than billing it 0', () => {
    // This is the failure the closed union exists to make loud: the default
    // model having no row is not a conservative default, it is a call that
    // bills nothing. 2.1 publishes the same rate card as gpt-realtime, verified
    // against its own pricing table rather than assumed from the family name.
    const priced = calculateRealtimeCostDollars('gpt-realtime-2.1', MEASURED_USAGE);

    expect(priced).toBeGreaterThan(0);
    expect(priced).toBe(calculateRealtimeCostDollars('gpt-realtime', MEASURED_USAGE));
  });

  it('returns 0 for absent usage', () => {
    expect(calculateRealtimeCostDollars('gpt-realtime', null)).toBe(0);
    expect(calculateRealtimeCostDollars('gpt-realtime', undefined)).toBe(0);
    expect(calculateRealtimeCostDollars('gpt-realtime', {})).toBe(0);
  });

  it('treats negative, NaN and Infinite counts as 0 rather than crediting the ledger', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        text_tokens: -100,
        audio_tokens: Number.NaN,
        image_tokens: Number.POSITIVE_INFINITY,
      },
      output_token_details: { text_tokens: -1, audio_tokens: 86 },
    });
    // Only the one valid quantity survives: 86 audio out x $64/1M.
    expect(cost).toBe(0.005504);
    expect(Number.isNaN(cost)).toBe(false);
  });

  it('never returns a negative charge from a fully malformed frame', () => {
    const cost = calculateRealtimeCostDollars('gpt-realtime', {
      input_token_details: {
        audio_tokens: -50,
        cached_tokens: -10,
        cached_tokens_details: { audio_tokens: -10 },
      },
      output_token_details: { text_tokens: Number.NaN },
    });
    expect(cost).toBe(0);
  });
});

describe('REALTIME_RATES env overrides', () => {
  const KEYS = [
    'REALTIME_INPUT_TEXT_USD_PER_TOKEN',
    'REALTIME_INPUT_AUDIO_USD_PER_TOKEN',
    'REALTIME_INPUT_IMAGE_USD_PER_TOKEN',
    'REALTIME_CACHED_INPUT_TEXT_USD_PER_TOKEN',
    'REALTIME_CACHED_INPUT_AUDIO_USD_PER_TOKEN',
    'REALTIME_CACHED_INPUT_IMAGE_USD_PER_TOKEN',
    'REALTIME_OUTPUT_TEXT_USD_PER_TOKEN',
    'REALTIME_OUTPUT_AUDIO_USD_PER_TOKEN',
  ];

  // Rates resolve at module-import time, so each case re-imports the module.
  beforeEach(() => {
    vi.resetModules();
    for (const key of KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('applies a valid override, so the fallback cases below are not vacuous', async () => {
    process.env.REALTIME_OUTPUT_AUDIO_USD_PER_TOKEN = '0.0001';
    const { REALTIME_RATES: overridden, calculateRealtimeCostDollars: calc } = await import(
      '../voice-pricing'
    );
    expect(overridden['gpt-realtime'].output.audio).toBe(0.0001);
    expect(calc('gpt-realtime', { output_token_details: { audio_tokens: 100 } })).toBe(0.01);
  });

  it('falls back to the published default for a non-numeric override', async () => {
    process.env.REALTIME_INPUT_AUDIO_USD_PER_TOKEN = 'garbage';
    const { REALTIME_RATES: overridden } = await import('../voice-pricing');
    expect(overridden['gpt-realtime'].input.audio).toBeCloseTo(32 / 1_000_000, 12);
  });

  it('falls back to the published default for a negative override', async () => {
    process.env.REALTIME_OUTPUT_TEXT_USD_PER_TOKEN = '-1';
    const { REALTIME_RATES: overridden } = await import('../voice-pricing');
    expect(overridden['gpt-realtime'].output.text).toBeCloseTo(24 / 1_000_000, 12);
  });

  it('falls back to the published default for an empty override', async () => {
    process.env.REALTIME_CACHED_INPUT_IMAGE_USD_PER_TOKEN = '   ';
    const { REALTIME_RATES: overridden } = await import('../voice-pricing');
    expect(overridden['gpt-realtime'].cachedInput.image).toBeCloseTo(0.5 / 1_000_000, 12);
  });

  it('honours an explicit zero rate (a free tier is a real price, not garbage)', async () => {
    process.env.REALTIME_INPUT_TEXT_USD_PER_TOKEN = '0';
    const { REALTIME_RATES: overridden } = await import('../voice-pricing');
    expect(overridden['gpt-realtime'].input.text).toBe(0);
  });
});
