import { expect } from 'vitest';

type AssertParams = {
  readonly given: string;
  readonly should: string;
  readonly actual: unknown;
  readonly expected: unknown;
};

/**
 * Riteway-style `assert` over vitest. Import it explicitly: an unimported
 * `assert` resolves to chai's truthiness assert and every call passes.
 */
export const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};
