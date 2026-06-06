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

import { estimateChatHoldCentsForModel, calcStepCostDollars, shouldAbortAfterStep } from '../chat-pricing';
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

describe('calcStepCostDollars', () => {
  it('returns the dollar cost from calculateCost for a known model with realistic tokens', () => {
    mockCalculateCost.mockReturnValue(0.10);
    const result = calcStepCostDollars('anthropic/claude-opus-4.8', { promptTokens: 1000, completionTokens: 500 });
    expect(mockCalculateCost).toHaveBeenCalledWith('anthropic/claude-opus-4.8', 1000, 500);
    expect(result).toBe(0.10);
  });

  it('returns 0 for an unknown model (calculateCost returns 0)', () => {
    mockCalculateCost.mockReturnValue(0);
    const result = calcStepCostDollars('some/unknown-model', { promptTokens: 1000, completionTokens: 500 });
    expect(mockCalculateCost).toHaveBeenCalledWith('some/unknown-model', 1000, 500);
    expect(result).toBe(0);
  });

  it('returns 0 when both token counts are zero', () => {
    mockCalculateCost.mockReturnValue(0);
    const result = calcStepCostDollars('anthropic/claude-opus-4.8', { promptTokens: 0, completionTokens: 0 });
    expect(result).toBe(0);
  });

  it('returns non-zero when only completionTokens are present for a known model', () => {
    mockCalculateCost.mockReturnValue(0.05);
    const result = calcStepCostDollars('openai/gpt-5', { promptTokens: 0, completionTokens: 2000 });
    expect(mockCalculateCost).toHaveBeenCalledWith('openai/gpt-5', 0, 2000);
    expect(result).toBe(0.05);
  });

  it('returns 0 if calculateCost throws', () => {
    mockCalculateCost.mockImplementation(() => { throw new Error('pricing error'); });
    expect(calcStepCostDollars('anthropic/claude-opus-4.8', { promptTokens: 1000, completionTokens: 500 })).toBe(0);
  });
});

describe('shouldAbortAfterStep', () => {
  // markupCents(0.10, 15000) = round(0.10 * 1.5 * 100) = 15¢
  // spendable = 500 - 15 = 485 > 25 → false
  it('returns false when spendable after markup exceeds reserve floor', () => {
    expect(shouldAbortAfterStep({
      cumulativeCostDollars: 0.10,
      balanceCents: 500,
      markupBps: 15000,
      reserveFloorCents: 25,
    })).toBe(false);
  });

  // markupCents(0.10, 15000) = 15¢; spendable = 30 - 15 = 15 <= 25 → true
  it('returns true when spendable after markup is below reserve floor', () => {
    expect(shouldAbortAfterStep({
      cumulativeCostDollars: 0.10,
      balanceCents: 30,
      markupBps: 15000,
      reserveFloorCents: 25,
    })).toBe(true);
  });

  // markupCents(0.10, 15000) = 15¢; spendable = 40 - 15 = 25 <= 25 → true (exact floor = abort)
  it('returns true when spendable equals the reserve floor exactly', () => {
    expect(shouldAbortAfterStep({
      cumulativeCostDollars: 0.10,
      balanceCents: 40,
      markupBps: 15000,
      reserveFloorCents: 25,
    })).toBe(true);
  });

  // balance=0 → always abort regardless of cost
  it('returns true when balance is zero', () => {
    expect(shouldAbortAfterStep({
      cumulativeCostDollars: 0.01,
      balanceCents: 0,
      markupBps: 15000,
      reserveFloorCents: 25,
    })).toBe(true);
  });

  // markupCents(0, 15000) = 0; spendable = 100 - 0 = 100 > 25 → false
  it('returns false when cumulative cost is zero and balance exceeds floor', () => {
    expect(shouldAbortAfterStep({
      cumulativeCostDollars: 0,
      balanceCents: 100,
      markupBps: 15000,
      reserveFloorCents: 25,
    })).toBe(false);
  });

  // Multi-step: balance=100, floor=25, markup=15000
  // cumulative $0.10→15¢ charged, $0.20→30¢, $0.30→45¢, $0.40→60¢, $0.50→75¢
  // 100-15=85>25 false, 100-30=70>25 false, 100-45=55>25 false, 100-60=40>25 false, 100-75=25<=25 true
  it('transitions from false to true at the correct cumulative step', () => {
    const base = { balanceCents: 100, markupBps: 15000, reserveFloorCents: 25 };
    expect(shouldAbortAfterStep({ ...base, cumulativeCostDollars: 0.10 })).toBe(false);
    expect(shouldAbortAfterStep({ ...base, cumulativeCostDollars: 0.20 })).toBe(false);
    expect(shouldAbortAfterStep({ ...base, cumulativeCostDollars: 0.30 })).toBe(false);
    expect(shouldAbortAfterStep({ ...base, cumulativeCostDollars: 0.40 })).toBe(false);
    expect(shouldAbortAfterStep({ ...base, cumulativeCostDollars: 0.50 })).toBe(true);
  });
});
