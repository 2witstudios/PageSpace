import { describe, it } from 'vitest';
import { assert } from './riteway';
import { isImageGenerationAllowed, isValidImageModel, shouldExposeImageGen } from '../image-gen-access';

describe('isImageGenerationAllowed (pure)', () => {
  it('allows app admins only', () => {
    assert({
      given: 'isAdmin true / false',
      should: 'allow admins only',
      actual: [true, false].map(isImageGenerationAllowed),
      expected: [true, false],
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
  const base = { imageGenEnabled: true, isAdmin: true, hasToolDef: true };

  it('exposes only when toggle on + tool present + admin', () => {
    assert({ given: 'toggle on, admin, tool present', should: 'expose', actual: shouldExposeImageGen(base), expected: true });
    assert({ given: 'toggle off', should: 'hide', actual: shouldExposeImageGen({ ...base, imageGenEnabled: false }), expected: false });
    assert({ given: 'non-admin', should: 'hide', actual: shouldExposeImageGen({ ...base, isAdmin: false }), expected: false });
    assert({ given: 'no tool def in baseline', should: 'hide', actual: shouldExposeImageGen({ ...base, hasToolDef: false }), expected: false });
  });
});
