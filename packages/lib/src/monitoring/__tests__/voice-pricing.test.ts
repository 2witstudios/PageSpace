import { describe, it, expect } from 'vitest';
import { calculateVoiceCostDollars, VOICE_RATES } from '../voice-pricing';

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

describe('VOICE_RATES defaults pinned to OpenAI published audio pricing', () => {
  it('whisper-1 = $0.006/min', () => {
    expect(VOICE_RATES['whisper-1'].usdPerSecond).toBeCloseTo(0.006 / 60, 12);
  });
  it('tts-1 = $15/1M chars, tts-1-hd = $30/1M chars', () => {
    expect(VOICE_RATES['tts-1'].usdPerChar).toBeCloseTo(15 / 1_000_000, 12);
    expect(VOICE_RATES['tts-1-hd'].usdPerChar).toBeCloseTo(30 / 1_000_000, 12);
  });
});
