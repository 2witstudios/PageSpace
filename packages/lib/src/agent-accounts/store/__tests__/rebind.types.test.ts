/**
 * ADR 0005 §10.21 (G1a review H2) — TYPE-LEVEL: `rebind` is not callable with an identity lacking
 * `audience: 'manage'`. `tsc` over this file is the assertion (an unused `@ts-expect-error` is
 * TS2578). Resolve-audience narrowing (§10.22, H6) is pinned in `__tests__/store-adapter.types.test.ts`.
 * The function is never called; vitest only proves the file loads.
 */
import { describe, expect, it } from 'vitest';
import type { RebindInput, StoreAdapter, StoreIdentity } from '../store-adapter';

export async function rebindNeedsAManageIdentity(adapter: StoreAdapter, identity: StoreIdentity, input: RebindInput) {
  await adapter.rebind(input);
  // @ts-expect-error — a StoreIdentity without audience 'manage' cannot rebind
  await adapter.rebind({ ...input, identity });
}

describe('StoreAdapter.rebind identity audience (ADR 0005 §10.21)', () => {
  it('given the type-level call sites, should be a function checked by tsc and never invoked', () => {
    const actual = typeof rebindNeedsAManageIdentity;
    const expected = 'function';
    expect(actual).toEqual(expected);
  });
});
