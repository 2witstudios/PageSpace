/**
 * The sheet modules must import cleanly when `@pagespace/db/operators` is
 * mocked.
 *
 * This is not a hypothetical. `query.ts` built its comparison operators from
 * `sql.raw(...)` in a module-level constant, so importing it — or anything
 * pulling in `store.ts` — threw `TypeError: sql.raw is not a function` in any
 * suite that mocks the operators module. Vitest reports that as an unhandled
 * error rather than a failing assertion, so CI went red while all 10,277 tests
 * reported passing, and the summary line looked healthy.
 *
 * The rule this pins: no SQL construction at module scope. Build fragments when
 * a function is called, so a mocked module only matters if the code is used.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { join: () => ({}) }
  ),
  and: () => ({}),
  or: () => ({}),
  eq: () => ({}),
  gte: () => ({}),
  inArray: () => ({}),
  asc: () => ({}),
}));

describe('sheet modules under a mocked operators module', () => {
  it('query.ts imports without evaluating SQL at module scope', async () => {
    const mod = await import('../sheets/query');
    expect(typeof mod.compileWhere).toBe('function');
    expect(typeof mod.assertColumn).toBe('function');
  });

  it('search-sql.ts imports without evaluating SQL at module scope', async () => {
    const mod = await import('../sheets/search-sql');
    expect(typeof mod.sheetCellsMatchIlike).toBe('function');
  });
});
