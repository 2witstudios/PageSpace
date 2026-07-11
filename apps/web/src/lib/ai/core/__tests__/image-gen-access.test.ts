import { describe, it } from 'vitest';
import { assert } from './riteway';
import { isImageGenerationAllowedForTier, isValidImageModel } from '../image-gen-access';

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
