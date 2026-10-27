import { describe, it, expect } from 'vitest';
import { isThenable } from '../isThenable';

describe('isThenable', () => {
  it('given a native Promise, should return true', () => {
    expect(isThenable(Promise.resolve('ok'))).toBe(true);
  });

  it('given a plain object with a callable `then`, should return true', () => {
    expect(isThenable({ then: () => {} })).toBe(true);
  });

  it('given a plain object without a `then` field, should return false', () => {
    expect(isThenable({ foo: 'bar' })).toBe(false);
  });

  it('given an object whose `then` is not a function, should return false', () => {
    expect(isThenable({ then: 'not-a-function' })).toBe(false);
  });

  it('given null, should return false', () => {
    expect(isThenable(null)).toBe(false);
  });

  it('given a primitive (string), should return false', () => {
    expect(isThenable('sendMessage() return value')).toBe(false);
  });

  it('given undefined, should return false', () => {
    expect(isThenable(undefined)).toBe(false);
  });
});
