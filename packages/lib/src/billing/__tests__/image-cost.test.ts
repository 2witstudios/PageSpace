import { describe, it, expect } from 'vitest';
import {
  resolveImageCost,
  IMAGE_GEN_FALLBACK_COST_DOLLARS,
  IMAGE_GEN_HOLD_ESTIMATE_CENTS,
} from '../credit-pricing';

const assert = ({ given, should, actual, expected }: { given: string; should: string; actual: unknown; expected: unknown }) =>
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('resolveImageCost (pure)', () => {
  it('bills the real OpenRouter cost verbatim when present', () => {
    assert({
      given: 'a positive providerCostDollars from usage.cost',
      should: 'return it with costSource openrouter',
      actual: resolveImageCost(0.0679225),
      expected: { costDollars: 0.0679225, costSource: 'openrouter' },
    });
  });

  it('falls back to a flat estimate when the provider cost is missing', () => {
    assert({
      given: 'undefined providerCostDollars',
      should: 'return the fallback with costSource estimate',
      actual: resolveImageCost(undefined, 0.05),
      expected: { costDollars: 0.05, costSource: 'estimate' },
    });
  });

  it('treats an authoritative ZERO cost as real (free image models must not be charged)', () => {
    assert({
      given: 'usage.cost === 0 from a free OpenRouter image model',
      should: 'bill $0 as a real cost, NOT fall through to the estimate',
      actual: resolveImageCost(0, 0.05),
      expected: { costDollars: 0, costSource: 'openrouter' },
    });
  });

  it('treats non-finite / absent provider cost as absent (estimate)', () => {
    assert({
      given: 'a NaN provider cost',
      should: 'use the estimate branch',
      actual: resolveImageCost(Number.NaN, 0.05).costSource,
      expected: 'estimate',
    });
    assert({
      given: 'a null provider cost',
      should: 'use the estimate branch',
      actual: resolveImageCost(null, 0.05).costSource,
      expected: 'estimate',
    });
  });

  it('exposes sane billing defaults', () => {
    expect(IMAGE_GEN_HOLD_ESTIMATE_CENTS).toBeGreaterThan(0);
    expect(IMAGE_GEN_FALLBACK_COST_DOLLARS).toBeGreaterThan(0);
  });
});
