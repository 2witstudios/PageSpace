/**
 * Drift guard for the `PageType` alias exported by
 * `apps/web/src/services/api/page-service.ts`. It used to be a hand-written
 * string union that omitted FILE, so FILE pages did not fit the type used for
 * API page data (#2150). It is now derived from the canonical enum in
 * `packages/lib/src/utils/enums.ts`.
 *
 * The `AssertExact` line is a compile-time-only check: if the two shapes ever
 * drift, `tsc` (`bun run typecheck`) fails right here with "Type 'false' is
 * not assignable to type 'true'" — before any test runs. Same pattern as
 * `packages/sdk/src/operations/__tests__/roles-pageperm-drift-guard.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { PageTypeValue } from '@pagespace/lib/utils/enums';
import type { PageType as ServicePageType } from '../page-service';

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const structurallyIdentical: AssertExact<ServicePageType, PageTypeValue> = true;

describe('page-service PageType — drift guard vs the canonical PageType enum', () => {
  it('is structurally identical to the lib enum values (enforced at compile time above)', () => {
    expect(structurallyIdentical).toBe(true);
  });

  it('admits FILE, the member the hand-written union dropped (#2150)', () => {
    const fileType: ServicePageType = 'FILE';
    expect(fileType).toBe('FILE');
  });

  it('admits MACHINE', () => {
    const machineType: ServicePageType = 'MACHINE';
    expect(machineType).toBe('MACHINE');
  });
});
