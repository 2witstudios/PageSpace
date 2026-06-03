import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the catalog so the test controls the per-call dollar estimate and the known-model
// set, without pulling the heavy ai-monitoring module (and its db deps) or pinning to
// live prices. AI_PRICING membership decides known-vs-unknown model handling.
const { mockCalculateCost } = vi.hoisted(() => ({ mockCalculateCost: vi.fn() }));
vi.mock('../ai-monitoring', () => ({
  calculateCost: mockCalculateCost,
  AI_PRICING: {
    'anthropic/claude-opus-4.8': { input: 5, output: 25 },
    'openai/gpt-5': { input: 1.25, output: 10 },
    'openai/gpt-5-nano': { input: 0.05, output: 0.4 },
    'openai/gpt-5.5-pro': { input: 30, output: 180 },
    default: { input: 0, output: 0 },
  },
}));

import { estimateChatHoldCentsForModel } from '../chat-pricing';
import {
  CHAT_HOLD_ASSUMED_INPUT_TOKENS,
  CHAT_HOLD_ASSUMED_OUTPUT_TOKENS,
  CHAT_HOLD_FLOOR_CENTS,
  CREDIT_HOLD_ESTIMATE_CENTS,
} from '../../billing/credit-pricing';

beforeEach(() => vi.clearAllMocks());

describe('estimateChatHoldCentsForModel', () => {
  it('marks up the catalog cost estimate and returns whole cents within the clamp range', () => {
    mockCalculateCost.mockReturnValue(0.10); // $0.10 real × 1.5 = 15¢
    expect(estimateChatHoldCentsForModel('anthropic/claude-opus-4.8')).toBe(15);
  });

  it('prices the model using the assumed token budget by default', () => {
    mockCalculateCost.mockReturnValue(0.05);
    estimateChatHoldCentsForModel('openai/gpt-5');
    expect(mockCalculateCost).toHaveBeenCalledWith(
      'openai/gpt-5',
      CHAT_HOLD_ASSUMED_INPUT_TOKENS,
      CHAT_HOLD_ASSUMED_OUTPUT_TOKENS,
    );
  });

  it('uses a caller-supplied input-token estimate when provided', () => {
    mockCalculateCost.mockReturnValue(0.05);
    estimateChatHoldCentsForModel('openai/gpt-5', { inputTokens: 12000 });
    expect(mockCalculateCost).toHaveBeenCalledWith(
      'openai/gpt-5',
      12000,
      CHAT_HOLD_ASSUMED_OUTPUT_TOKENS,
    );
  });

  it('clamps a cheap (but known) model up to the floor', () => {
    mockCalculateCost.mockReturnValue(0.0001);
    expect(estimateChatHoldCentsForModel('openai/gpt-5-nano')).toBe(CHAT_HOLD_FLOOR_CENTS);
  });

  it('clamps an expensive model down to the legacy chat-hold ceiling', () => {
    mockCalculateCost.mockReturnValue(1.0); // $1 × 1.5 = 150¢ → capped
    expect(estimateChatHoldCentsForModel('openai/gpt-5.5-pro')).toBe(CREDIT_HOLD_ESTIMATE_CENTS);
  });

  it('falls back to the legacy flat hold for an UNKNOWN model (never the 2¢ floor)', () => {
    // An unrecognized model would price to $0 in the catalog and clamp to the floor —
    // unsafe. Reserve the legacy flat estimate instead, and don't even price it.
    expect(estimateChatHoldCentsForModel('some/unlisted-model')).toBe(CREDIT_HOLD_ESTIMATE_CENTS);
    expect(mockCalculateCost).not.toHaveBeenCalled();
  });

  it('falls back to the legacy flat hold when no model is supplied', () => {
    expect(estimateChatHoldCentsForModel(undefined)).toBe(CREDIT_HOLD_ESTIMATE_CENTS);
    expect(mockCalculateCost).not.toHaveBeenCalled();
  });

  it('treats inherited Object keys (e.g. "toString", "constructor") as unknown models', () => {
    // Guards against `model in AI_PRICING` matching prototype members and pricing a
    // bogus model off Object.prototype. Own-property check only.
    expect(estimateChatHoldCentsForModel('toString')).toBe(CREDIT_HOLD_ESTIMATE_CENTS);
    expect(estimateChatHoldCentsForModel('constructor')).toBe(CREDIT_HOLD_ESTIMATE_CENTS);
    expect(mockCalculateCost).not.toHaveBeenCalled();
  });
});
