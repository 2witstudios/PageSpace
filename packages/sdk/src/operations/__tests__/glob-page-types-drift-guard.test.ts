/**
 * Drift guard for `GLOB_SEARCH_PAGE_TYPES`, inlined in `operations/search.ts`
 * so the published SDK never runtime- or type-imports `@pagespace/lib` (a
 * published `.d.ts` referencing an unpublished internal package would break a
 * consumer's `tsc`). This test-only import from `@pagespace/lib` (a
 * devDependency, never in the published `dist`) asserts the inlined list is
 * exactly the canonical `PageType` enum in
 * `packages/lib/src/utils/enums.ts` — the same pattern
 * `./roles-pageperm-drift-guard.test.ts` uses for `PagePerm`.
 *
 * Filed as #2150: the inlined list had drifted to 8 of 10 members, so SDK and
 * CLI callers could not filter glob search for FILE or MACHINE pages.
 *
 * The `AssertExact` line is a compile-time-only check: if the two lists ever
 * diverge, `tsc` (this package's `typecheck`/`pretest` script) fails right
 * here with "Type 'false' is not assignable to type 'true'" — before any test
 * even runs.
 */
import { describe, expect, it } from 'vitest';
import { PageType, PAGE_TYPE_VALUES } from '@pagespace/lib/utils/enums';
import { GLOB_SEARCH_PAGE_TYPES } from '../search.js';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const structurallyIdentical: AssertExact<
  (typeof GLOB_SEARCH_PAGE_TYPES)[number],
  `${PageType}`
> = true;

describe('operations/search.ts GLOB_SEARCH_PAGE_TYPES — drift guard vs the canonical PageType enum', () => {
  it('is type-identical to the lib enum values (enforced at compile time above)', () => {
    expect(structurallyIdentical).toBe(true);
  });

  it('has the same members as the lib enum at runtime', () => {
    expect([...GLOB_SEARCH_PAGE_TYPES].sort()).toEqual([...PAGE_TYPE_VALUES].sort());
  });

  it('includes FILE and MACHINE, the two members it had drifted away from (#2150)', () => {
    expect(GLOB_SEARCH_PAGE_TYPES).toContain('FILE');
    expect(GLOB_SEARCH_PAGE_TYPES).toContain('MACHINE');
  });
});
