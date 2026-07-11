import { describe, it } from 'vitest';
import { assert } from './riteway';
import { isImageGenerationAllowedForTier, isValidImageModel, shouldExposeImageGen } from '../image-gen-access';

describe('isImageGenerationAllowedForTier (pure)', () => {
  it('allows only paid tiers', () => {
    assert({
      given: 'free/pro/founder/business/undefined/null',
      should: 'allow pro/founder/business only',
      actual: ['free', 'pro', 'founder', 'business', undefined, null].map(isImageGenerationAllowedForTier),
      expected: [false, true, true, true, false, false],
    });
  });
});

describe('isValidImageModel (pure)', () => {
  const available = [{ id: 'a/one' }, { id: 'b/two' }];
  it('accepts ids in the available list, rejects others', () => {
    assert({ given: 'an available id', should: 'be valid', actual: isValidImageModel('b/two', available), expected: true });
    assert({ given: 'an unknown id', should: 'be invalid', actual: isValidImageModel('c/three', available), expected: false });
  });
});

describe('shouldExposeImageGen (pure)', () => {
  const base = { imageGenEnabled: true, tier: 'pro', isAdmin: false, hasToolDef: true };

  it('exposes only when toggle on + tool present + paid/admin', () => {
    assert({ given: 'toggle on, pro, tool present', should: 'expose', actual: shouldExposeImageGen(base), expected: true });
    assert({ given: 'toggle off', should: 'hide', actual: shouldExposeImageGen({ ...base, imageGenEnabled: false }), expected: false });
    assert({ given: 'free tier', should: 'hide', actual: shouldExposeImageGen({ ...base, tier: 'free' }), expected: false });
    assert({ given: 'free tier but admin', should: 'expose', actual: shouldExposeImageGen({ ...base, tier: 'free', isAdmin: true }), expected: true });
    assert({ given: 'no tool def in baseline', should: 'hide', actual: shouldExposeImageGen({ ...base, hasToolDef: false }), expected: false });
  });
});
