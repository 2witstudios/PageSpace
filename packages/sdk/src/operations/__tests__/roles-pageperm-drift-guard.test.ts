/**
 * Drift guard for `PagePerm`, inlined in `operations/roles.ts` so the
 * published SDK never runtime- or type-imports `@pagespace/lib` (a
 * published `.d.ts` referencing an unpublished internal package would break
 * a consumer's `tsc`). This test-only import from `@pagespace/lib` (a
 * devDependency, never in the published `dist`) asserts structural equality
 * against the canonical source of truth in
 * `packages/lib/src/permissions/membership-queries.ts`, the same pattern
 * `../../__tests__/api-contract-guard.test.ts` uses for `MIN_SERVER_API_VERSION`.
 *
 * The `AssertExact` line is a compile-time-only check: if the two shapes
 * ever drift, `tsc` (this package's `typecheck`/`pretest` script) fails
 * right here with "Type 'false' is not assignable to type 'true'" — before
 * any test even runs.
 */
import { describe, expect, it } from 'vitest';
import type { PagePerm as LibPagePerm } from '@pagespace/lib/permissions/membership-queries';
import type { PagePerm as SdkPagePerm } from '../roles.js';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const structurallyIdentical: AssertExact<SdkPagePerm, LibPagePerm> = true;

describe('operations/roles.ts PagePerm — drift guard vs @pagespace/lib canonical shape', () => {
  it('is structurally identical to the lib canonical PagePerm (enforced at compile time above)', () => {
    expect(structurallyIdentical).toBe(true);
  });

  it('a value satisfying one type satisfies the other interchangeably', () => {
    const fromLibShape: LibPagePerm = { canView: true, canEdit: false, canShare: true };
    const asSdkShape: SdkPagePerm = fromLibShape;
    expect(asSdkShape).toEqual(fromLibShape);
  });
});
