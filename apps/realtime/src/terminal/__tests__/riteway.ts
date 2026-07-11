import { expect } from 'vitest';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

export const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};
