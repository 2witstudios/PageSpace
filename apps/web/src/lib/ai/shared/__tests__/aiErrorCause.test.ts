import { describe, it, expect } from 'vitest';
import { isAIErrorCause } from '../aiErrorCause';

const valid = {
  code: 'out_of_credits',
  httpStatus: 402,
  message: 'balance too low',
  retryable: false,
};

describe('isAIErrorCause', () => {
  it('given a fully valid AIErrorCause, should return true', () => {
    expect(isAIErrorCause(valid)).toBe(true);
  });

  it('given httpStatus is null, should still be valid (the legacy string path)', () => {
    expect(isAIErrorCause({ ...valid, httpStatus: null })).toBe(true);
  });

  it('given null or a non-object, should return false', () => {
    expect(isAIErrorCause(null)).toBe(false);
    expect(isAIErrorCause(undefined)).toBe(false);
    expect(isAIErrorCause('a string')).toBe(false);
    expect(isAIErrorCause(42)).toBe(false);
  });

  // PR 6 review (CodeRabbit): the old guard only checked key presence, not types — an
  // arbitrary-shaped .cause with wrong-typed fields would be trusted downstream and could
  // crash rendering or show the wrong billing CTA.
  it('given code is not one of the known values, should return false', () => {
    expect(isAIErrorCause({ ...valid, code: 'totally_made_up' })).toBe(false);
  });

  it('given retryable is not a boolean, should return false', () => {
    expect(isAIErrorCause({ ...valid, retryable: 'no' })).toBe(false);
  });

  it('given message is not a string, should return false', () => {
    expect(isAIErrorCause({ ...valid, message: {} })).toBe(false);
  });

  it('given httpStatus is neither null nor an integer, should return false', () => {
    expect(isAIErrorCause({ ...valid, httpStatus: 'not-a-number' })).toBe(false);
    expect(isAIErrorCause({ ...valid, httpStatus: 4.5 })).toBe(false);
  });

  it('given a required field is missing entirely, should return false', () => {
    const { code: _code, ...withoutCode } = valid;
    expect(isAIErrorCause(withoutCode)).toBe(false);
  });
});
