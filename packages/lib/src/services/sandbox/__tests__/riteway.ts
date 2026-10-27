import { expect } from 'vitest';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

/**
 * Minimal riteway-style `assert` over vitest, mirroring the local shim used
 * across apps/web tests. Keeps the {given, should, actual, expected} unit-test
 * shape without pulling in a separate test framework.
 */
export const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};
