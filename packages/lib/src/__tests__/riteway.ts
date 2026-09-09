import { expect, it } from 'vitest';

interface AssertParams<T> {
  given: string;
  should: string;
  actual: T;
  expected: T;
}

/**
 * riteway-style test DECLARATION (given/should/actual/expected) on top of
 * vitest — the repo doesn't vendor riteway, so keep the contract and drop the
 * package. Each call declares its own `it`, so it belongs at `describe` level
 * and never inside another test.
 *
 * One copy, because two identical shims had accumulated (app-hosting and fly)
 * and that is two chances for the contract to drift while both suites still
 * call it `assert`.
 *
 * It lives in a `__tests__` directory rather than beside `src/test/setup.ts`
 * for a build reason: `tsconfig.build.json` excludes every `__tests__`
 * directory, so a helper importing `vitest` — a devDependency — never reaches
 * `dist`.
 *
 * NOT the same helper as `services/sandbox/__tests__/riteway.ts`, despite the
 * shared name: that one is a bare `expect` assertion meant to be called INSIDE
 * an `it`. Merging them would break every caller of whichever contract lost.
 */
export const assert = <T>({ given, should, actual, expected }: AssertParams<T>): void => {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
};
