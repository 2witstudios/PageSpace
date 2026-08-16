import { expect, it } from 'vitest';

interface AssertParams<T> {
  given: string;
  should: string;
  actual: T;
  expected: T;
}

/**
 * riteway-style assertion (given/should/actual/expected) on top of vitest — the
 * repo doesn't vendor riteway, so keep the contract and drop the package. Mirrors
 * the shim in services/sandbox/__tests__/riteway.ts.
 */
export const assert = <T>({ given, should, actual, expected }: AssertParams<T>): void => {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
};
