import { describe, it, expect } from 'vitest';
import { defaultRuleRange } from '../conditional-ops';

// The rule operations themselves moved to @pagespace/lib/sheets/conditional-ops
// and are covered by packages/lib/src/__tests__/sheet-conditional-ops.test.ts.
// What stays here is the one helper that reads the grid's selection.
describe('defaultRuleRange', () => {
  it('offers the selected range', () => {
    expect(
      defaultRuleRange({ type: 'range', range: { start: { row: 0, column: 0 }, end: { row: 8, column: 0 } } })
    ).toBe('A1:A9');
  });

  it('offers the single selected cell', () => {
    expect(defaultRuleRange({ type: 'single', cell: { row: 2, column: 1 } })).toBe('B3');
  });
});
