import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_FORMAT_CELLS,
  MAX_FORMAT_CELLS_PER_REQUEST,
  MAX_FORMAT_OPS,
  SheetFormatError,
  planFormatOps,
  type SheetFormatOp,
  type SheetFormatPlan,
  type SheetFormatTarget,
} from '../sheets/format-request';
import { setColumnWidth, setRowHeight } from '../sheets/format-ops';
import { createEmptySheet } from '../sheets/io';
import {
  MAX_CONDITIONAL_RULES,
  MAX_CONDITIONAL_TOTAL_CELLS,
  parseConditionalRule,
  type ConditionalRule,
} from '../sheets/conditional';
import {
  MAX_REGIONS,
  MAX_REGION_COLUMNS,
  MAX_REGION_TOTAL_ROWS,
  parseRegion,
  type SheetRegion,
} from '../sheets/regions';
import { PALETTE } from '../sheets/palette';
import { isSupportedFunction } from '../sheets/functions';
import { MAX_ADDRESSABLE_ROW, encodeColumnLabel } from '../sheets/address';
import { MAX_CONDITIONAL_RANGES_PER_RULE, VALUELESS_OPERATORS } from '../sheets/conditional';

const tabWith = (overrides: Partial<SheetFormatTarget> = {}): SheetFormatTarget => ({
  rowCount: 100,
  columnCount: 26,
  ...overrides,
});

const rule = (id: string, over = '10'): ConditionalRule => ({
  id,
  kind: 'cell',
  ranges: ['A1:A9'],
  condition: { operator: 'greaterThan', value: over },
  format: { background: '#fee2e2' },
});

const region = (id: string, range = 'A1:F'): SheetRegion => ({ id, range });

const plan = (ops: SheetFormatOp[], tab: SheetFormatTarget = tabWith()): SheetFormatPlan =>
  planFormatOps(ops, tab);

/** The refusal message, so a test can assert on what a model would be told. */
const refusalOf = (ops: SheetFormatOp[], tab: SheetFormatTarget = tabWith()): string => {
  try {
    planFormatOps(ops, tab);
  } catch (error) {
    if (error instanceof SheetFormatError) return error.message;
    throw error;
  }
  throw new Error('Expected a SheetFormatError, but planning succeeded.');
};

describe('planFormatOps — the request envelope', () => {
  it('plans nothing for an empty batch, rather than inventing work', () => {
    const result = plan([]);
    expect(result.steps).toEqual([]);
    expect(result.touchesTabFields).toBe(false);
    expect([...result.rows]).toEqual([]);
  });

  it('refuses ops that are not an array', () => {
    // Kills: dropping the array guard, which would make `.length` undefined and
    // `forEach` throw a TypeError the caller would answer 500 to.
    expect(() => planFormatOps(undefined as unknown as SheetFormatOp[], tabWith())).toThrow(
      SheetFormatError
    );
  });

  it('refuses a batch past MAX_FORMAT_OPS', () => {
    const ops = Array.from({ length: MAX_FORMAT_OPS + 1 }, () => ({
      type: 'clearCellFormat' as const,
      range: 'A1',
    }));
    expect(refusalOf(ops)).toContain(`at most ${MAX_FORMAT_OPS} ops`);
  });

  it('refuses an op that is not an object with a type', () => {
    expect(refusalOf([null as unknown as SheetFormatOp])).toContain('Op 0');
    expect(refusalOf([{ range: 'A1' } as unknown as SheetFormatOp])).toContain('must be an object');
  });

  it('refuses an unknown op type by name', () => {
    // Kills: a permissive default that would let a typo'd op type be planned as
    // a silent no-op — the failure mode this whole module exists to remove.
    expect(refusalOf([{ type: 'setCellFromat', range: 'A1' } as unknown as SheetFormatOp])).toContain(
      'unknown op type "setCellFromat"'
    );
  });
});

describe('planFormatOps — ranges', () => {
  it('resolves a range to its addresses and to the 0-based rows it touches', () => {
    const result = plan([{ type: 'setCellFormat', range: 'B2:C3', patch: { bold: true } }]);
    expect(result.steps).toEqual([
      { type: 'setCellFormat', addresses: ['B2', 'C2', 'B3', 'C3'], patch: { bold: true } },
    ]);
    // Kills: emitting 1-based rows, which would lock and load the wrong records.
    expect([...result.rows].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(result.touchesTabFields).toBe(false);
  });

  it('accepts a bare cell', () => {
    expect(plan([{ type: 'clearCellFormat', range: 'a1' }]).steps).toEqual([
      { type: 'clearCellFormat', addresses: ['A1'] },
    ]);
  });

  it.each([
    ['not a string', 42 as unknown as string, 'range must be a string'],
    ['empty', '', 'not a range'],
    ['truncated', 'A1:', 'not a range'],
    ['three-cornered', 'A1:B2:C3', 'not a range'],
    ['not an address', 'HELLO', 'not a range'],
    ['row zero', 'A0:B2', 'not a range'],
    ['past the last row', 'A5000002', 'not a range'],
    ['past the last column', 'ZZZZ1', 'not a range'],
  ])('refuses a range that is %s', (_label, range, expected) => {
    // Kills: any loosening of `parseRangeSpan`. `A1:` in particular decodes to
    // the single cell A1 if the truncation guard goes, which looks like it
    // worked and formats one cell out of a table.
    expect(refusalOf([{ type: 'clearCellFormat', range }])).toContain(expected);
  });

  it('refuses a range past MAX_FORMAT_CELLS and points at the better tool', () => {
    const message = refusalOf([
      { type: 'setCellFormat', range: `A1:A${MAX_FORMAT_CELLS + 1}`, patch: { bold: true } },
    ]);
    expect(message).toContain((MAX_FORMAT_CELLS + 1).toLocaleString());
    expect(message).toContain('setColumnFormat');
  });

  it('refuses a batch whose ranges sum past the per-request budget', () => {
    // Each op is individually legal; only the aggregate is not. Kills: deleting
    // the per-request accumulator, which would leave the per-op cap decorative.
    const per = 45_000;
    const ops: SheetFormatOp[] = Array.from({ length: 5 }, () => ({
      type: 'clearCellFormat' as const,
      range: `A1:A${per}`,
    }));
    expect(per).toBeLessThan(MAX_FORMAT_CELLS);
    expect(per * 5).toBeGreaterThan(MAX_FORMAT_CELLS_PER_REQUEST);
    expect(refusalOf(ops)).toContain('per-request limit');
  });
});

describe('planFormatOps — cell format patches', () => {
  it('refuses an unknown field by name (#4)', () => {
    // `cellFormatSchema` is a plain z.object, so `.parse({bolt: true})` returns
    // `{}` and reports success. Kills: validating with the schema alone, which
    // turns a typo into a successful request that formats nothing.
    const message = refusalOf([{ type: 'setCellFormat', range: 'A1', patch: { bolt: true } as never }]);
    expect(message).toContain('"bolt" is not a format field');
    expect(message).toContain('bold');
  });

  it('refuses a prototype-reaching key', () => {
    const patch = JSON.parse('{"__proto__": {"bold": true}}') as never;
    expect(refusalOf([{ type: 'setCellFormat', range: 'A1', patch }])).toContain('not a format field');
  });

  it('refuses a patch that is not an object, and one with no fields', () => {
    expect(refusalOf([{ type: 'setCellFormat', range: 'A1', patch: null as never }])).toContain(
      'must be an object'
    );
    // A field-less patch applies cleanly and changes nothing.
    expect(refusalOf([{ type: 'setCellFormat', range: 'A1', patch: {} }])).toContain('no fields');
  });

  it('refuses an invalid field value and names the zod path', () => {
    expect(
      refusalOf([{ type: 'setCellFormat', range: 'A1', patch: { color: 'red' as never } }])
    ).toContain('color: Expected a #rrggbb color');
    expect(
      refusalOf([
        { type: 'setCellFormat', range: 'A1', patch: { number: { kind: 'currency', decimals: 99 } } },
      ])
    ).toContain('number.decimals');
  });

  it('hands the CALLER’S object downstream so an explicit undefined still clears (#3)', () => {
    // `setCellFormats` reads a present-but-undefined field as "clear this".
    // Zod does not preserve one: `cellFormatSchema.parse({bold: undefined})` is
    // `{}`. Kills: piping `result.data`, which turns every "turn bold off" in
    // the product into a silent no-op that reports success.
    const patch = { bold: undefined };
    const step = plan([{ type: 'setCellFormat', range: 'A1', patch }]).steps[0];
    if (step.type !== 'setCellFormat') throw new Error('expected a setCellFormat step');

    expect(step.patch).toBe(patch);
    expect(Object.keys(step.patch)).toEqual(['bold']);
    expect('bold' in step.patch).toBe(true);
  });
});

describe('planFormatOps — columns, rows and freezes', () => {
  it('resolves a column label to a 0-based index', () => {
    expect(plan([{ type: 'setColumnFormat', column: 'ab', patch: { bold: true } }]).steps).toEqual([
      { type: 'setColumnFormat', columnIndex: 27, patch: { bold: true } },
    ]);
  });

  it.each([
    ['not a string', 3 as unknown as string, 'must be letters'],
    ['not letters', 'C3', 'is not a column label'],
    ['eight letters', 'AAAAAAAA', 'is not a column label'],
    ['past ZZZ', 'ZZZZ', 'past the last addressable column'],
  ])('refuses a column that is %s', (_label, column, expected) => {
    expect(refusalOf([{ type: 'setColumnWidth', column, width: 100 }])).toContain(expected);
  });

  it('refuses a width outside the bounds instead of clamping it (#2)', () => {
    // The trap: `setColumnWidth` clamps, so a test that applies the op and
    // asserts the stored width is 24 passes under BOTH the correct
    // implementation and the broken one. What distinguishes them is whether the
    // clamping setter is reached at all — so nothing may be recorded here.
    const applied: Array<number | undefined> = [];
    const applyWidths = (ops: SheetFormatOp[]) => {
      let sheet = createEmptySheet();
      for (const step of planFormatOps(ops, tabWith()).steps) {
        if (step.type !== 'setColumnWidth') continue;
        sheet = setColumnWidth(sheet, step.columnIndex, step.width);
        applied.push(sheet.columnWidths?.A);
      }
    };

    expect(() => applyWidths([{ type: 'setColumnWidth', column: 'A', width: 8 }])).toThrow(
      SheetFormatError
    );
    expect(applied).toEqual([]);

    // And the clamp is provably a no-op for everything that does get through.
    applyWidths([{ type: 'setColumnWidth', column: 'A', width: 240 }]);
    expect(applied).toEqual([240]);
  });

  it('refuses a height outside the bounds instead of clamping it', () => {
    const applied: Array<number | undefined> = [];
    const applyHeights = (ops: SheetFormatOp[]) => {
      let sheet = createEmptySheet();
      for (const step of planFormatOps(ops, tabWith()).steps) {
        if (step.type !== 'setRowHeight') continue;
        sheet = setRowHeight(sheet, step.rowIndex, step.height);
        applied.push(sheet.rowHeights?.['1']);
      }
    };

    expect(() => applyHeights([{ type: 'setRowHeight', row: 1, height: 4000 }])).toThrow(
      SheetFormatError
    );
    expect(applied).toEqual([]);
  });

  it.each([
    ['not a number', 'wide' as unknown as number, 'must be a number of pixels'],
    ['fractional', 100.5, 'whole number of pixels'],
    ['under the minimum', 8, 'between 24 and 2000'],
    ['over the maximum', 5000, 'between 24 and 2000'],
  ])('refuses a width that is %s', (_label, width, expected) => {
    expect(refusalOf([{ type: 'setColumnWidth', column: 'A', width }])).toContain(expected);
  });

  it('reads null as "clear this", not as a missing value', () => {
    expect(plan([{ type: 'setColumnWidth', column: 'A', width: null }]).steps).toEqual([
      { type: 'setColumnWidth', columnIndex: 0, width: undefined },
    ]);
    expect(plan([{ type: 'setRowHeight', row: 3, height: null }]).steps).toEqual([
      { type: 'setRowHeight', rowIndex: 2, height: undefined },
    ]);
  });

  it('takes rows 1-based and stores them 0-based', () => {
    expect(plan([{ type: 'setRowHeight', row: 7, height: 40 }]).steps).toEqual([
      { type: 'setRowHeight', rowIndex: 6, height: 40 },
    ]);
  });

  it.each([
    ['zero', 0],
    ['fractional', 2.5],
    ['not a number', 'first' as unknown as number],
    ['past the last row', MAX_ADDRESSABLE_ROW + 2],
  ])('refuses a row height addressed at %s', (_label, row) => {
    expect(refusalOf([{ type: 'setRowHeight', row, height: 40 }])).toContain('1-based row number');
  });

  it('accepts a row height on the last addressable row, as the range path does', () => {
    // `MAX_ADDRESSABLE_ROW` is a 0-based index everywhere it is compared, so a
    // 1-based API row must be bounded by `row - 1`. Comparing `row` to it
    // directly left the last row able to take a cell format but not a row
    // height — a disagreement between two ops of the same request that no
    // caller could see coming. Kills: restoring the `row > MAX_ADDRESSABLE_ROW`
    // comparison.
    const last = MAX_ADDRESSABLE_ROW + 1;
    expect(plan([{ type: 'setRowHeight', row: last, height: 40 }]).steps).toEqual([
      { type: 'setRowHeight', rowIndex: MAX_ADDRESSABLE_ROW, height: 40 },
    ]);
    // The range path already accepted this cell, which is what made the
    // inconsistency observable.
    expect(plan([{ type: 'clearCellFormat', range: `A${last}` }]).steps).toEqual([
      { type: 'clearCellFormat', addresses: [`A${last}`] },
    ]);
  });

  it('plans a freeze inside the sheet extent', () => {
    const result = plan([{ type: 'setFrozen', rows: 1, columns: null }]);
    expect(result.steps).toEqual([{ type: 'setFrozen', rows: 1, columns: undefined }]);
    expect(result.touchesTabFields).toBe(true);
  });

  it('accepts 0 as "unfreeze", which is what setFrozen already means by it', () => {
    expect(plan([{ type: 'setFrozen', rows: 0, columns: 0 }]).steps).toEqual([
      { type: 'setFrozen', rows: 0, columns: 0 },
    ]);
  });

  it.each([
    ['negative', { rows: -1, columns: null }, 'whole number of 0 or more'],
    ['fractional', { rows: 1.5, columns: null }, 'whole number of 0 or more'],
    ['past the row extent', { rows: 500, columns: null }, 'frozen rows is 500'],
    ['past the column extent', { rows: null, columns: 99 }, 'frozen columns is 99'],
  ])('refuses a freeze that is %s', (_label, freeze, expected) => {
    expect(refusalOf([{ type: 'setFrozen', ...freeze }])).toContain(expected);
  });
});

describe('planFormatOps — conditional rules', () => {
  it('refuses a blank custom-formula rule (#1, the PR #2540 bug verbatim)', () => {
    // `parseConditionalRule` returns null for a formula rule whose formula is
    // blank, so the rule was stored, reported as added, and gone on reload.
    // Kills: accepting the caller's rule object without parsing it.
    const blank = { id: 'cf_1', kind: 'formula', ranges: ['A1:A9'], formula: '   ', format: { bold: true } };
    expect(parseConditionalRule(blank)).toBeNull();
    expect(refusalOf([{ type: 'addConditionalRule', rule: blank }])).toContain(
      'not a rule this sheet can store'
    );
  });

  it('adds a rule as the parser stores it, and marks the tab touched', () => {
    const result = plan([{ type: 'addConditionalRule', rule: rule('cf_1') }]);
    expect(result.conditionalFormats).toEqual([rule('cf_1')]);
    expect(result.steps).toEqual([{ type: 'setConditionalRules', rules: [rule('cf_1')] }]);
    expect(result.touchesTabFields).toBe(true);
  });

  it('refuses a rule whose ranges the panel would also refuse', () => {
    // `validateRanges` is the shared definition; reimplementing it here is how
    // the API and the panel come to disagree about the same rule.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: ['A1:A600000'] } }])
    ).toContain('is not a range this sheet can format');
    expect(refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: [] } }])).toContain(
      'Enter at least one range'
    );
  });

  it('refuses an add past the rule cap', () => {
    const existing = Array.from({ length: MAX_CONDITIONAL_RULES }, (_, i) => rule(`cf_${i}`));
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: rule('cf_new') }], tabWith({ conditionalFormats: existing }))
    ).toContain(`maximum of ${MAX_CONDITIONAL_RULES} rules`);
  });

  it('refuses rules that individually clear every cap but sum past the aggregate (#6)', () => {
    // `expandRangesWithinBudget` spends MAX_CONDITIONAL_TOTAL_CELLS and then
    // BREAKS, silently: past the budget, rules simply stop being applied at
    // render time. Kills: deleting the aggregate sum, since each rule here is
    // legal on its own and every other cap is satisfied.
    const big = (id: string, cells: number): ConditionalRule => ({
      ...rule(id),
      ranges: [`A1:A${cells}`],
    });
    const existing = [big('a', 495_000), big('b', 495_000), big('c', 495_000), big('d', 495_000)];
    const tab = tabWith({ conditionalFormats: existing });

    expect(495_000 * 4).toBeLessThan(MAX_CONDITIONAL_TOTAL_CELLS);
    const message = refusalOf([{ type: 'addConditionalRule', rule: big('e', 30_000) }], tab);
    expect(message).toContain('sheet-wide limit');
    expect(message).toContain((495_000 * 4 + 30_000).toLocaleString());

    // Just under the aggregate still goes through, so the refusal is the budget
    // and not the rule count.
    expect(plan([{ type: 'addConditionalRule', rule: big('e', 15_000) }], tab).conditionalFormats)
      .toHaveLength(5);
  });

  it('lets an already over-budget sheet be repaired one rule at a time', () => {
    // A sheet can already be past the aggregate ceiling: the panel's `addRule`
    // enforces the per-rule and rule-count caps but not this one. Refusing every
    // write on such a sheet leaves it unrepairable — removing a rule strictly
    // reduces the skipped render work, and would have been rejected for not
    // fixing everything in one request.
    const big = (id: string): ConditionalRule => ({ ...rule(id), ranges: ['A1:A400000'] });
    const over = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(big);
    const tab = tabWith({ conditionalFormats: over });

    expect(400_000 * 7).toBeGreaterThan(MAX_CONDITIONAL_TOTAL_CELLS);

    // Still over afterwards, and still accepted, because it is lower.
    const repaired = plan([{ type: 'removeConditionalRule', id: 'g' }], tab);
    expect(repaired.conditionalFormats).toHaveLength(6);

    // Making it worse is still refused.
    expect(refusalOf([{ type: 'addConditionalRule', rule: big('h') }], tab)).toContain(
      'over the sheet-wide limit'
    );
    // As is a swap that raises the total without adding a rule.
    expect(
      refusalOf(
        [{ type: 'updateConditionalRule', id: 'g', patch: { ranges: ['A1:A490000'] } }],
        tab
      )
    ).toContain('over the sheet-wide limit');
  });

  it('does not charge the aggregate for ranges the evaluator would skip', () => {
    // A range past the per-range cap contributes nothing to evaluation, so
    // counting it toward the aggregate would refuse a sheet for work it was
    // never going to do.
    const skipped: ConditionalRule = { ...rule('skip'), ranges: ['A1:A600000', 'NOPE'] };
    const result = plan([{ type: 'addConditionalRule', rule: rule('cf_1') }], tabWith({ conditionalFormats: [skipped] }));
    expect(result.conditionalFormats).toHaveLength(2);
  });

  it('updates a rule in place, keeping its precedence', () => {
    const tab = tabWith({ conditionalFormats: [rule('a'), rule('b')] });
    const result = plan([{ type: 'updateConditionalRule', id: 'a', patch: { ranges: ['B1:B4'] } }], tab);
    expect(result.conditionalFormats[0].ranges).toEqual(['B1:B4']);
    expect(result.conditionalFormats[1]).toEqual(rule('b'));
  });

  it('refuses an update to an id that is not present, listing the ones that are', () => {
    // `updateRule`-shaped code returns "no change" for an unknown id, which over
    // the API is indistinguishable from success.
    const tab = tabWith({ conditionalFormats: [rule('a'), rule('b')] });
    const message = refusalOf([{ type: 'updateConditionalRule', id: 'zzz', patch: { bold: true } }], tab);
    expect(message).toContain('No rule "zzz"');
    expect(message).toContain('"a", "b"');
  });

  it('refuses an update whose patch is unusable', () => {
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    expect(refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: null as never }], tab)).toContain(
      'patch must be an object'
    );
    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { ranges: ['A1:A600000'] } }], tab)
    ).toContain('is not a range this sheet can format');
    // A patch that empties the format leaves a rule the parser drops on load.
    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { format: {} } }], tab)
    ).toContain('rule format has no fields');
    // A patch is validated as a whole rule, so the kind's own requirements hold.
    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { condition: 'big' } }], tab)
    ).toContain('not a rule this sheet can store');
  });

  it('refuses an id that is not a non-empty string', () => {
    expect(refusalOf([{ type: 'removeConditionalRule', id: '' }])).toContain('non-empty string');
    expect(refusalOf([{ type: 'removeConditionalRule', id: 7 as unknown as string }])).toContain(
      'non-empty string'
    );
  });

  it('removes a rule, and refuses to remove one that is not there', () => {
    const tab = tabWith({ conditionalFormats: [rule('a'), rule('b')] });
    expect(plan([{ type: 'removeConditionalRule', id: 'a' }], tab).conditionalFormats).toEqual([rule('b')]);
    expect(refusalOf([{ type: 'removeConditionalRule', id: 'a' }])).toContain('Present rules: none');
  });

  it('moves a rule, and refuses a move with nowhere to go', () => {
    const tab = tabWith({ conditionalFormats: [rule('a'), rule('b')] });
    expect(
      plan([{ type: 'moveConditionalRule', id: 'a', direction: 1 }], tab).conditionalFormats.map((r) => r.id)
    ).toEqual(['b', 'a']);
    // Rule order IS precedence, so a move that did not happen is not a detail.
    expect(refusalOf([{ type: 'moveConditionalRule', id: 'a', direction: -1 }], tab)).toContain(
      'already first'
    );
    expect(refusalOf([{ type: 'moveConditionalRule', id: 'b', direction: 1 }], tab)).toContain(
      'already last'
    );
    expect(refusalOf([{ type: 'moveConditionalRule', id: 'zzz', direction: 1 }], tab)).toContain(
      'No rule "zzz"'
    );
    expect(
      refusalOf([{ type: 'moveConditionalRule', id: 'a', direction: 2 as unknown as 1 }], tab)
    ).toContain('direction must be -1');
  });

  it('clears every rule, and clearing none is not an error', () => {
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    const result = plan([{ type: 'clearConditionalRules' }], tab);
    expect(result.conditionalFormats).toEqual([]);
    expect(result.steps).toEqual([{ type: 'setConditionalRules', rules: [] }]);

    // Unlike removing an id that is not there: a clear names no target and so
    // cannot be wrong about one.
    expect(plan([{ type: 'clearConditionalRules' }]).conditionalFormats).toEqual([]);
  });

  it('refuses a resulting rule list that would come back shorter', () => {
    // The round-trip detector: a tab already holding more rules than the parser
    // will read back means any write to that list loses some of it, whatever
    // this module's own caps say.
    const existing = Array.from({ length: MAX_CONDITIONAL_RULES + 5 }, (_, i) => rule(`cf_${i}`));
    const message = refusalOf(
      [{ type: 'updateConditionalRule', id: 'cf_0', patch: { format: { bold: true } } }],
      tabWith({ conditionalFormats: existing })
    );
    expect(message).toContain('would be dropped when the sheet is read back');
    expect(message).toContain('Nothing was applied');
  });
});

describe('planFormatOps — nothing the parser would quietly rewrite', () => {
  // `parseConditionalRule` and `parseRegion` are LOAD-path parsers: they
  // sanitize field by field so one bad setting cannot cost a user the rest of a
  // stored document. Reused as-is on a WRITE path that generosity is a lie —
  // the sheet stores something other than what was asked for and reports
  // success. Every case below was accepted before the readback comparator.

  it('refuses a rule format that would lose one of its fields', () => {
    // `parseCellFormat` keeps the bold and drops the too-small size, so the
    // rule was stored, reported as added, and rendered without the size.
    const message = refusalOf([
      { type: 'addConditionalRule', rule: { ...rule('cf_1'), format: { bold: true, fontSize: 5 } } },
    ]);
    expect(message).toContain('rule format.fontSize');
  });

  it('refuses an unknown field inside a rule format', () => {
    // Carried THROUGH by `parseCellFormat` rather than dropped, so nothing is
    // lost and the comparator sees nothing wrong — it has to be named here.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), format: { bolt: true } } }])
    ).toContain('"bolt" is not a format field');
  });

  it('refuses a ranges array past the per-rule cap instead of truncating it', () => {
    // The ordering bug this exists to prevent: `parseConditionalRule` slices
    // `ranges` to the cap FIRST, so a `validateRanges` call afterwards is handed
    // a list that fits, pronounces it fine, and every range past the cap is gone
    // with no refusal anywhere. Kills: moving the check after the parse.
    const ranges = Array.from({ length: MAX_CONDITIONAL_RANGES_PER_RULE + 1 }, () => 'A1:A2');
    expect(refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges } }])).toContain(
      `at most ${MAX_CONDITIONAL_RANGES_PER_RULE} ranges`
    );
  });

  it('refuses a ranges array holding anything but strings', () => {
    // `readRanges` filters non-strings and blanks out silently.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: ['A1:A9', 42] } }])
    ).toContain('array of A1 ranges');
    expect(refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: 'A1:A9' } }])).toContain(
      'array of A1 ranges'
    );
    expect(refusalOf([{ type: 'addConditionalRule', rule: 'a rule' }])).toContain('rule must be an object');
  });

  it('refuses a condition value the parser would drop', () => {
    // A numeric threshold is dropped by the parser's `typeof === "string"`
    // check, leaving an operator with nothing to compare against.
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: { ...rule('cf_1'), condition: { operator: 'greaterThan', value: 10 } },
        },
      ])
    ).toContain('"condition.value"');
  });

  it('refuses a scale anchor whose colour the parser would drop', () => {
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: {
            id: 'cf_1',
            kind: 'dataBar',
            ranges: ['A1:A9'],
            color: '#3b82f6',
            min: { type: 'number', value: 0, color: 'blue' },
          },
        },
      ])
    ).toContain('"min.color"');
  });

  it('refuses a region option the parser would sanitize away', () => {
    // `headerRows: 999` is dropped and silently becomes the default of one.
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), headerRows: 999 } }])).toContain(
      'region: "headerRows"'
    );
    // An unusable column declaration disappears from the list.
    expect(
      refusalOf([
        { type: 'upsertRegion', region: { ...region('r1'), columns: [{ column: 'C', role: 'money' }] } },
      ])
    ).toContain('region: "columns"');
    expect(
      refusalOf([
        {
          type: 'upsertRegion',
          region: { ...region('r1'), columns: [{ column: 'C', role: 'number', decimals: 99 }] },
        },
      ])
    ).toContain('region: "columns"');
    // A shorter list back is always a loss, whatever the surviving entries say.
    expect(
      refusalOf([
        {
          type: 'upsertRegion',
          region: {
            ...region('r1'),
            columns: [
              { column: 'C', role: 'currency' },
              { column: 'D', role: 'money' },
            ],
          },
        },
      ])
    ).toContain('region: "columns"');
    // And the same check runs on every entry of a `setRegions` list.
    expect(
      refusalOf([{ type: 'setRegions', regions: [region('r1'), { ...region('r2'), theme: 'BLUE!' }] }])
    ).toContain('regions[1]: "theme"');
  });

  it('refuses a scale anchor that would be stored verbatim and mean something else', () => {
    // The comparator is blind here on purpose: `readAnchor` returns null for an
    // anchor it cannot read, and the rule builder then keeps the caller's
    // original through its `...value` spread. Nothing is dropped — the anchor
    // is stored EXACTLY as written and quietly means something different.
    //
    // Measured against the evaluator, a colorScale whose `mid` colour is
    // unusable produces `{}` — not a two-stop gradient, no formatting at all —
    // while the identical rule with `#ff0000` paints every cell in range.
    const scale = (mid: unknown) => ({
      id: 'cs',
      kind: 'colorScale',
      ranges: ['A1:A9'],
      min: { type: 'min', color: '#ffffff' },
      mid,
      max: { type: 'max', color: '#000000' },
    });

    expect(
      refusalOf([{ type: 'addConditionalRule', rule: scale({ type: 'percentile', value: 50, color: 'redd' }) }])
    ).toContain("colorScale's mid anchor needs a #rrggbb colour");
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: scale({ type: 'midpoint', color: '#ff0000' }) }])
    ).toContain("colorScale's mid anchor needs a type of");
    // A valid mid still goes through, and an omitted one is a two-stop scale.
    expect(
      plan([{ type: 'addConditionalRule', rule: scale({ type: 'percentile', value: 50, color: '#ff0000' }) }])
        .conditionalFormats
    ).toHaveLength(1);
    expect(
      plan([{ type: 'addConditionalRule', rule: scale(undefined) }]).conditionalFormats
    ).toHaveLength(1);

    // A dataBar anchor the parser cannot read is not blank, but it is not what
    // was asked for either: `anchorValue` falls back to the data's own extreme,
    // so `{type: 'nubmer', value: 50}` silently becomes "the smallest value".
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: {
            id: 'db',
            kind: 'dataBar',
            ranges: ['A1:A9'],
            color: '#3b82f6',
            min: { type: 'nubmer', value: 50 },
          },
        },
      ])
    ).toContain("dataBar's min anchor needs a type of");
  });

  it('covers the parsers’ own caps without being told about them', () => {
    // The claim the comparator makes is that a cap added to a parser later is
    // refused here without this module learning it. These two are already in
    // `regions.ts` and nothing in this module mentions either — they are caught
    // purely because a truncated list comes back shorter than it went in.
    // Distinct labels, or this would demonstrate the parser's de-duplication
    // rather than its cap — the refusal would look identical and mean something
    // else.
    const columns = Array.from({ length: MAX_REGION_COLUMNS + 1 }, (_, i) => ({
      column: encodeColumnLabel(i),
      role: 'text',
    }));
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), columns } }])).toContain(
      'region: "columns"'
    );

    const totalRows = Array.from({ length: MAX_REGION_TOTAL_ROWS + 1 }, (_, i) => i + 2);
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), totalRows } }])).toContain(
      'region: "totalRows"'
    );
  });

  it('refuses a cell rule missing the operand its operator needs', () => {
    // `matchesCondition` compares against nothing: a `greaterThan` with no
    // value matches NO cell, and a `notContains` with no value matches EVERY
    // non-error one — opposite failures, equally silent. The parser accepts
    // both and the comparator sees nothing dropped.
    const cell = (condition: unknown) => ({ ...rule('cf_1'), condition });

    expect(
      refusalOf([{ type: 'addConditionalRule', rule: cell({ operator: 'greaterThan' }) }])
    ).toContain('needs a value to compare against');
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: cell({ operator: 'notContains', value: '  ' }) }])
    ).toContain('needs a value to compare against');
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: cell({ operator: 'between', value: '1' }) }])
    ).toContain('needs both bounds');

    // The operators that legitimately compare against nothing still pass, and
    // that list is the panel's own — imported, not restated.
    for (const operator of VALUELESS_OPERATORS) {
      expect(
        plan([{ type: 'addConditionalRule', rule: cell({ operator }) }]).conditionalFormats
      ).toHaveLength(1);
    }
    expect(
      plan([{ type: 'addConditionalRule', rule: cell({ operator: 'between', value: '1', value2: '9' }) }])
        .conditionalFormats
    ).toHaveLength(1);
  });

  it('refuses a formula that does not parse', () => {
    // The parser asks only that a formula be non-blank. The evaluator then
    // throws while tokenizing it once per covered cell, catches, and formats
    // none of them — checked here with the engine's own tokenizer and parser so
    // "valid" means the same thing in both places.
    const formula = (body: string) => ({
      id: 'cf_1',
      kind: 'formula',
      ranges: ['A1:A9'],
      formula: body,
      format: { bold: true },
    });

    expect(refusalOf([{ type: 'addConditionalRule', rule: formula('=BROKEN(') }])).toContain(
      'is not a formula this sheet can evaluate'
    );
    expect(refusalOf([{ type: 'addConditionalRule', rule: formula('=A1 >') }])).toContain(
      'is not a formula this sheet can evaluate'
    );
    expect(refusalOf([{ type: 'addConditionalRule', rule: formula('=') }])).toContain(
      'is not a formula this sheet can evaluate'
    );
    // With or without the leading `=`, as the evaluator reads it.
    expect(plan([{ type: 'addConditionalRule', rule: formula('=A1>1') }]).conditionalFormats).toHaveLength(1);
    expect(plan([{ type: 'addConditionalRule', rule: formula('SUM(A1:A9)>0') }]).conditionalFormats)
      .toHaveLength(1);
  });

  it('refuses a scale anchor whose value the evaluator would substitute or clamp', () => {
    const bar = (min: unknown) => ({
      id: 'db',
      kind: 'dataBar',
      ranges: ['A1:A9'],
      color: '#3b82f6',
      min,
    });

    // `anchorValue` substitutes the data's own extreme for a missing value...
    expect(refusalOf([{ type: 'addConditionalRule', rule: bar({ type: 'number' }) }])).toContain(
      'of type number needs a numeric value'
    );
    // ...and clamps a percent that is out of range.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: bar({ type: 'percent', value: 150 }) }])
    ).toContain('needs a value from 0 to 100, not 150');
    // `min` and `max` read the data and ignore any value, so they need none.
    expect(plan([{ type: 'addConditionalRule', rule: bar({ type: 'min' }) }]).conditionalFormats)
      .toHaveLength(1);
    expect(
      plan([{ type: 'addConditionalRule', rule: bar({ type: 'percentile', value: 90 }) }])
        .conditionalFormats
    ).toHaveLength(1);
  });

  it('refuses a region declaration that names something outside the region', () => {
    // `createRegionResolver` excludes cells outside the bounds before consulting
    // either list, so these are stored faithfully and can never render.
    // Cross-field, so the comparator cannot see them: each value is fine alone.
    expect(
      refusalOf([
        {
          type: 'upsertRegion',
          region: { id: 'r1', range: 'A1:B10', columns: [{ column: 'Z', role: 'currency' }] },
        },
      ])
    ).toContain('column "Z" is outside the region A1:B10');
    expect(
      refusalOf([{ type: 'upsertRegion', region: { id: 'r1', range: 'A1:B10', totalRows: [20] } }])
    ).toContain('total row 20 is outside the region A1:B10');

    // Totals are checked against the region's BODY, not its bounds. The
    // resolver applies the header treatment and `continue`s, so a total inside
    // the header band never reaches the total treatment — and a region starting
    // below row 1 has rows above it that are not part of it at all. Neither is
    // visible to a bounds-only check, and an OPEN region skipped the check
    // entirely.
    expect(
      refusalOf([
        { type: 'upsertRegion', region: { id: 'r1', range: 'A10:F', totalRows: [1] } },
      ])
    ).toContain('total row 1 is not in the body of A10:F');
    expect(
      refusalOf([
        {
          type: 'upsertRegion',
          region: { id: 'r1', range: 'A1:F20', headerRows: 2, totalRows: [2] },
        },
      ])
    ).toContain('its totals start at row 3');

    // The first body row itself is fine, and so is a default single header row.
    expect(
      plan([
        {
          type: 'upsertRegion',
          region: { id: 'r1', range: 'A1:F20', headerRows: 2, totalRows: [3, 20] },
        },
      ]).regions[0].totalRows
    ).toEqual([3, 20]);
    expect(
      plan([{ type: 'upsertRegion', region: { id: 'r1', range: 'A10:F', totalRows: [11] } }]).regions
    ).toHaveLength(1);

    // An OPEN region reaches the end of the sheet, so a total row past today's
    // extent is a row it will grow into — which is the point of leaving the end
    // off, and must not be refused.
    expect(
      plan([{ type: 'upsertRegion', region: { id: 'r1', range: 'A1:F', totalRows: [4000] } }]).regions[0]
        .totalRows
    ).toEqual([4000]);
    expect(
      plan([{ type: 'upsertRegion', region: { id: 'r1', range: 'A1:B10', totalRows: [10] } }]).regions
    ).toHaveLength(1);
  });

  it('refuses a column setting the column’s own role does not use', () => {
    // `columnRoleFormat` reads `currency` only for `role: 'currency'` and
    // `decimals` only for the numeric roles, so `{role: 'number', currency:
    // 'EUR'}` is stored, ignored, and looks from the outside like money that
    // lost its symbol.
    const withColumn = (column: unknown) => ({ id: 'r1', range: 'A1:F', columns: [column] });

    expect(
      refusalOf([
        { type: 'upsertRegion', region: withColumn({ column: 'C', role: 'number', currency: 'EUR' }) },
      ])
    ).toContain('declares currency, which a "number" column does not use');
    expect(
      refusalOf([
        { type: 'upsertRegion', region: withColumn({ column: 'C', role: 'date', decimals: 2 }) },
      ])
    ).toContain('declares decimals, which a "date" column does not use');

    // The roles that DO read them still work, including the case that a naive
    // "does removing it change anything?" check would get wrong: `USD` on a
    // currency column matches the default, so it is redundant — not a mistake.
    for (const column of [
      { column: 'C', role: 'currency', currency: 'EUR' },
      { column: 'C', role: 'currency', currency: 'USD' },
      { column: 'C', role: 'number', decimals: 0 },
      { column: 'C', role: 'percent', decimals: 1 },
    ]) {
      expect(plan([{ type: 'upsertRegion', region: withColumn(column) }]).regions[0].columns)
        .toHaveLength(1);
    }
  });

  it('refuses freezeHeader while nothing acts on it', () => {
    // Parsed and stored, with no consumer anywhere: `createRegionResolver` does
    // not read it and the `setRegions` step only stores the region. Accepting
    // it would be this module's own contract broken in its own output.
    expect(
      refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), freezeHeader: true } }])
    ).toContain('freezeHeader is not applied by anything yet');
    expect(
      refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), freezeHeader: true } }])
    ).toContain('setFrozen');
    // An explicit false asks for nothing and gets nothing, which is honest.
    expect(
      plan([{ type: 'upsertRegion', region: { ...region('r1'), freezeHeader: false } }]).regions
    ).toHaveLength(1);
  });

  it('refuses an unknown key NESTED inside a format', () => {
    // The top-level key check cannot see this one, and `cellFormatSchema`
    // strips it from the nested object just as quietly: the rule parses, the
    // renderer ignores the misspelling and shows the default currency, and the
    // field is gone entirely on the next load.
    const message = refusalOf([
      {
        type: 'setCellFormat',
        range: 'A1',
        patch: { number: { kind: 'currency', curreny: 'EUR' } } as never,
      },
    ]);
    expect(message).toContain('patch.number.curreny');

    // And the top-level clearing behaviour has to survive the same check: a raw
    // `undefined` is not a loss, whatever zod does with it.
    const patch = { bold: undefined, number: { kind: 'currency' as const, currency: 'EUR' } };
    const step = plan([{ type: 'setCellFormat', range: 'A1', patch }]).steps[0];
    if (step.type !== 'setCellFormat') throw new Error('expected a setCellFormat step');
    expect(step.patch).toBe(patch);
  });

  it('refuses a non-numeric operand for an operator that compares numbers', () => {
    // A non-blank operand passes the missing-value check and still makes the
    // rule inert: `matchesCondition` coerces it, gets null, and returns false
    // for every cell.
    const cell = (condition: unknown) => ({ ...rule('cf_1'), condition });

    expect(
      refusalOf([
        { type: 'addConditionalRule', rule: cell({ operator: 'greaterThan', value: 'abc' }) },
      ])
    ).toContain('compares numbers, and value is "abc"');
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: cell({ operator: 'between', value: '1', value2: 'ten' }),
        },
      ])
    ).toContain('value2 is "ten"');

    // `equal` and the text operators are deliberately NOT in that set — they
    // fall back to a text comparison, so `= "done"` is a real rule.
    for (const operator of ['equal', 'notEqual', 'contains', 'startsWith']) {
      expect(
        plan([{ type: 'addConditionalRule', rule: cell({ operator, value: 'done' }) }])
          .conditionalFormats
      ).toHaveLength(1);
    }
    expect(
      plan([{ type: 'addConditionalRule', rule: cell({ operator: 'greaterThan', value: ' 10 ' }) }])
        .conditionalFormats
    ).toHaveLength(1);
  });

  it('refuses a formula calling a function this build does not implement', () => {
    // Parsing proves the grammar, not the vocabulary: `FormulaParser` accepts
    // any identifier followed by parentheses, and `evaluateFunction` then
    // throws for a name it does not implement — once per covered cell.
    const formula = (body: string) => ({
      id: 'cf_1',
      kind: 'formula',
      ranges: ['A1:A9'],
      formula: body,
      format: { bold: true },
    });

    expect(refusalOf([{ type: 'addConditionalRule', rule: formula('=BROKEN()') }])).toContain(
      'calls BROKEN(), which this sheet does not implement'
    );
    // Nested inside an expression, which is why the check walks the whole tree.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: formula('=SUM(A1:A9) + NOPE(1)') }])
    ).toContain('calls NOPE()');
    // Under a unary operator too, which is its own branch of the walk.
    expect(refusalOf([{ type: 'addConditionalRule', rule: formula('=-NOPE(1)>0') }])).toContain(
      'calls NOPE()'
    );
    // Real functions still pass, including nested and lazily-evaluated ones.
    for (const body of ['=SUM(A1:A9)>0', '=IF(A1>1, 2, 3)', '=IFERROR(SUM(A1:A9), 0)']) {
      expect(plan([{ type: 'addConditionalRule', rule: formula(body) }]).conditionalFormats)
        .toHaveLength(1);
    }
  });

  it('recognises every function the dispatch actually implements', () => {
    // `isSupportedFunction` probes the switch instead of listing its names, and
    // this is the assertion that the probe is sound in the direction that
    // matters: a FALSE negative would refuse a formula that works perfectly.
    //
    // The names are read out of the source rather than written here, because a
    // list in this file is the second copy the probe exists to avoid — it would
    // drift the first time someone adds a function, and the test would keep
    // passing while saying nothing.
    const source = readFileSync(new URL('../sheets/functions.ts', import.meta.url), 'utf8');
    const names = [...new Set([...source.matchAll(/case '([A-Z0-9_.]+)'/g)].map((m) => m[1]))];

    // A regex that stops matching would leave an empty list and a test that
    // passes vacuously, which is the failure mode this whole suite is built
    // against.
    expect(names.length).toBeGreaterThan(40);

    expect(names.filter((name) => !isSupportedFunction(name))).toEqual([]);
    expect(isSupportedFunction('BROKEN')).toBe(false);
  });

  it('refuses a value nested past what it will verify, rather than dying on it', () => {
    // The parsers preserve unknown fields on purpose, so a caller can attach an
    // arbitrarily deep value to an otherwise valid region. An unbounded walk
    // over it is a RangeError, which escapes as a 500 — the one outcome
    // `SheetFormatError` exists to prevent.
    //
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 5_000; i++) deep = { next: deep };

    // Refused wherever it sits, including where the identity fast path would
    // have skipped the walk entirely. That shortcut is a performance
    // optimisation, not a verification — accepting a value BECAUSE it was too
    // deep to look at would turn the bound into a hole, and this module's whole
    // claim is that what it stores has been checked.
    for (const region of [
      { id: 'r1', range: 'A1:F', columns: [{ column: 'B', role: 'text', extra: deep }] },
      { id: 'r1', range: 'A1:F', extra: deep },
    ]) {
      expect(refusalOf([{ type: 'upsertRegion', region }])).toContain('nested more than');
    }

    // Twelve levels is far past anything these shapes reach on their own — the
    // deepest is `borders.top.color`, at three — so nothing real is caught.
    expect(
      plan([
        {
          type: 'setCellFormat',
          range: 'A1',
          patch: { borders: { top: { style: 'thin', color: '#123456' } } },
        },
      ]).steps
    ).toHaveLength(1);
  });

  it('refuses a theme the palette does not have, which would render as another colour', () => {
    // `parseRegion` accepts any lowercase word and `hueByName` then falls back
    // to the default at RENDER time — so this is a sanitization the comparator
    // cannot see, and the one place the module has to know something the
    // parsers do not. An agent that asked for a chartreuse dashboard and got
    // slate was told the write succeeded.
    const message = refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), theme: 'chartreuse' } }]);
    expect(message).toContain('is not a hue this build has');
    expect(message).toContain('slate, blue');
    // Every palette hue is still accepted, so the check cannot drift from the
    // palette it is checking against.
    for (const hue of PALETTE) {
      expect(plan([{ type: 'upsertRegion', region: { ...region('r1'), theme: hue.name } }]).regions[0].theme)
        .toBe(hue.name);
    }
  });

  it('does not mistake a genuine normalization for a loss', () => {
    // The comparator has to allow exactly what the parsers are entitled to do,
    // or every well-formed request starts being refused. Kills: comparing
    // strings or list order strictly.
    const result = plan([
      {
        type: 'upsertRegion',
        region: {
          id: 'r1',
          range: 'a1:f',
          name: '  Budget  ',
          theme: 'Blue',
          totalRows: [7, 3],
          columns: [{ column: 'c', role: 'currency', currency: 'usd' }],
        },
      },
    ]);

    expect(result.regions[0]).toEqual({
      id: 'r1',
      range: 'A1:F',
      name: 'Budget',
      theme: 'blue',
      totalRows: [3, 7],
      columns: [{ column: 'C', role: 'currency', currency: 'USD' }],
    });
  });

  it('treats an explicit null as a value the parser dropped, not as an omission', () => {
    // A caller who means "not set" omits the key — JSON can say that — so a
    // null that comes back as nothing is a real sanitization, and often a
    // damaging one: the parser deletes `condition.value` and leaves a
    // `greaterThan` rule with no threshold, which matches no cell and reads as
    // a rule that simply does not work.
    // Kills: canonicalizing undefined and null to the same string.
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: { ...rule('cf_1'), condition: { operator: 'greaterThan', value: null } },
        },
      ])
    ).toContain('"condition.value"');
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), headerRows: null } }])).toContain(
      'region: "headerRows"'
    );
    // An OMITTED field is still not a loss, which is the distinction that has
    // to survive: omitting `theme` is how you say you do not want one.
    expect(plan([{ type: 'upsertRegion', region: region('r1') }]).regions).toEqual([
      { id: 'r1', range: 'A1:F' },
    ]);
  });

  it('refuses a rule range outside the addressable sheet, before anything expands it', () => {
    // `addressesOfRange` bounds the cell COUNT and negative coordinates, never
    // the extent, so `A5000002` passes as one legal cell.
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: ['A5000002'] } }])
    ).toContain('is not a range this sheet can address');
    expect(
      refusalOf([{ type: 'addConditionalRule', rule: { ...rule('cf_1'), ranges: ['ZZZZ1:ZZZZ9'] } }])
    ).toContain('is not a range this sheet can address');

    // The one that matters: past 2^53 a row number loses integer precision, so
    // `row++` inside the expansion loop stops advancing and it runs to its
    // 500,000-address ceiling. Measured against `addressesOfRange` directly,
    // this range yields 500,000 copies of the single malformed address
    // `A1e+21` — not a hang, but tens of megabytes of garbage allocated inside
    // what is supposed to be a cheap check, and every one of those entries
    // would then be stored and handed to the evaluator.
    //
    // The assertion is the refusal itself, and deliberately nothing about how
    // long it took. A wall-clock bound would be the only flaky line in this
    // file, and it could not even tell the two paths apart — the bad one takes
    // 18ms, so any threshold loose enough to survive a busy runner passes for
    // both. What proves the work is skipped is the ORDER: the bounds check runs
    // before `validateRanges`, and a mutation probe on that line turns red.
    expect(
      refusalOf([
        {
          type: 'addConditionalRule',
          rule: {
            ...rule('cf_1'),
            ranges: ['A1000000000000000000000:A1000000000000000200000'],
          },
        },
      ])
    ).toContain('is not a range this sheet can address');
  });

  it('still lets a rule written by a NEWER build be updated', () => {
    // The pre-parse checks are stricter than the parser, so applying them to a
    // whole merged rule — mostly the STORED one — would refuse any update to a
    // rule carrying a field this build does not know, which `parseCellFormat`
    // deliberately preserves. That is the cross-version data loss the
    // passthrough exists to prevent, arriving as a refusal instead.
    // Kills: validating `raw` rather than the caller's `supplied` fields.
    // Cast because `sparkle` is exactly what this build does not know about.
    const stored = { ...rule('a'), format: { bold: true, sparkle: 3 } } as unknown as ConditionalRule;
    const tab = tabWith({ conditionalFormats: [stored] });

    const result = plan([{ type: 'updateConditionalRule', id: 'a', patch: { ranges: ['B1:B4'] } }], tab);
    expect(result.conditionalFormats[0]).toMatchObject({
      ranges: ['B1:B4'],
      format: { bold: true, sparkle: 3 },
    });

    // A format the caller supplies is still held to the strict bar.
    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { format: { sparkle: 4 } } }], tab)
    ).toContain('"sparkle" is not a format field');
  });

  it('holds only the caller’s ranges to the range caps, as the panel does', () => {
    // `updateRule` in the panel validates `patch.ranges` and nothing else. A
    // stored rule whose ranges the evaluator already skips must stay editable,
    // or a sheet can reach a state where no rule on it can be fixed.
    const stored: ConditionalRule = { ...rule('a'), ranges: ['A1:A600000'] };
    const tab = tabWith({ conditionalFormats: [stored] });

    expect(
      plan([{ type: 'updateConditionalRule', id: 'a', patch: { format: { bold: true } } }], tab)
        .conditionalFormats[0]
    ).toMatchObject({ format: { bold: true } });

    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { ranges: ['A1:A600000'] } }], tab)
    ).toContain('is not a range this sheet can format');
  });

  it('refuses a field whose very SHAPE the parser would replace', () => {
    // A list where a string belongs, or an object where a number belongs, is
    // dropped whole — the comparator has to notice a type change, not only a
    // missing key.
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), name: ['Budget'] } }])).toContain(
      'region: "name"'
    );
    expect(refusalOf([{ type: 'upsertRegion', region: { ...region('r1'), headerRows: {} } }])).toContain(
      'region: "headerRows"'
    );
  });

  it('carries an unknown field from a newer build through untouched', () => {
    // Forward compatibility is the reason the parsers pass unknown fields
    // through, and the comparator must not undo it.
    const result = plan([
      { type: 'addConditionalRule', rule: { ...rule('cf_1'), stripes: { every: 2 } } },
      {
        type: 'upsertRegion',
        // Nested inside a list entry, which is where a naive comparison of
        // canonical forms would trip over its own recursion.
        region: { ...region('r1'), columns: [{ column: 'C', role: 'text', tags: ['wide', 'sticky'] }] },
      },
    ]);
    expect(result.conditionalFormats[0]).toMatchObject({ stripes: { every: 2 } });
    expect(result.regions[0].columns).toEqual([{ column: 'C', role: 'text', tags: ['wide', 'sticky'] }]);
  });
});

describe('planFormatOps — rule identity', () => {
  it('refuses adding a rule whose id is already on the sheet', () => {
    // Two rules under one id: `update` and `move` reach the first by index
    // while `remove` filters out both, so the new rule is not addressable at
    // all. The region path already refused this.
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    const message = refusalOf([{ type: 'addConditionalRule', rule: rule('a') }], tab);
    expect(message).toContain('A rule "a" is already on this sheet');
    expect(message).toContain('updateConditionalRule');
  });

  it('refuses an update that asks for nothing', () => {
    // `id` and `kind` are pinned to the rule being edited, so a patch naming
    // only those is applied, reports success and changes not one pixel.
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    expect(refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: {} }], tab)).toContain(
      'patch changes nothing'
    );
    expect(
      refusalOf([{ type: 'updateConditionalRule', id: 'a', patch: { id: 'b', kind: 'formula' } }], tab)
    ).toContain('patch changes nothing');
  });

  it('keeps a rule’s identity when a patch tries to change it', () => {
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    const result = plan(
      [{ type: 'updateConditionalRule', id: 'a', patch: { id: 'b', format: { bold: true } } }],
      tab
    );
    expect(result.conditionalFormats[0].id).toBe('a');
  });
});

describe('planFormatOps — regions', () => {
  it('sets a region list', () => {
    const result = plan([{ type: 'setRegions', regions: [{ id: 'r1', range: 'a1:f' }] }]);
    expect(result.regions).toEqual([{ id: 'r1', range: 'A1:F' }]);
    expect(result.steps).toEqual([{ type: 'setRegions', regions: [{ id: 'r1', range: 'A1:F' }] }]);
    expect(result.touchesTabFields).toBe(true);
  });

  it('refuses a region list that is not an array, or is past the cap', () => {
    expect(refusalOf([{ type: 'setRegions', regions: 'A1:F' as never }])).toContain('must be an array');
    const many = Array.from({ length: MAX_REGIONS + 1 }, (_, i) => region(`r${i}`));
    expect(refusalOf([{ type: 'setRegions', regions: many }])).toContain(`at most ${MAX_REGIONS} regions`);
  });

  it('clears the region list with an empty array', () => {
    const result = plan([{ type: 'setRegions', regions: [] }], tabWith({ regions: [region('r1')] }));
    expect(result.regions).toEqual([]);
    expect(result.steps).toEqual([{ type: 'setRegions', regions: [] }]);
  });

  it('refuses an unusable region, naming its position', () => {
    expect(refusalOf([{ type: 'setRegions', regions: [region('r1'), { range: 'A1:F' }] }])).toContain(
      'regions[1] is not a region'
    );
  });

  it('refuses two regions sharing an id', () => {
    // `parseRegions` keeps the first and drops the rest, so a duplicate id is a
    // region lost between the write and the next read.
    expect(refusalOf([{ type: 'setRegions', regions: [region('r1'), region('r1', 'H1:J9')] }])).toContain(
      'Two regions share the id "r1"'
    );
  });

  it('upserts by id: appends a new one, replaces an existing one in place', () => {
    const tab = tabWith({ regions: [region('r1'), region('r2', 'H1:J9')] });
    expect(plan([{ type: 'upsertRegion', region: region('r3', 'L1:M9') }], tab).regions.map((r) => r.id))
      .toEqual(['r1', 'r2', 'r3']);

    const replaced = plan([{ type: 'upsertRegion', region: region('r1', 'B2:D9') }], tab).regions;
    expect(replaced.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(replaced[0].range).toBe('B2:D9');
  });

  it('refuses an unusable region and an upsert past the cap', () => {
    expect(refusalOf([{ type: 'upsertRegion', region: { id: 'r1', range: 'A1' } }])).toContain(
      'not a region this sheet can store'
    );
    const full = Array.from({ length: MAX_REGIONS }, (_, i) => region(`r${i}`));
    expect(refusalOf([{ type: 'upsertRegion', region: region('new') }], tabWith({ regions: full }))).toContain(
      `maximum of ${MAX_REGIONS} regions`
    );
  });

  it('removes a region, and refuses to remove one that is not there', () => {
    const tab = tabWith({ regions: [region('r1'), region('r2')] });
    expect(plan([{ type: 'removeRegion', id: 'r1' }], tab).regions.map((r) => r.id)).toEqual(['r2']);

    const message = refusalOf([{ type: 'removeRegion', id: 'nope' }], tab);
    expect(message).toContain('No region "nope"');
    expect(message).toContain('"r1", "r2"');
    expect(refusalOf([{ type: 'removeRegion', id: 'nope' }])).toContain('Present regions: none');
  });

  it('refuses a resulting region list that would come back shorter', () => {
    const existing = Array.from({ length: MAX_REGIONS + 3 }, (_, i) => region(`r${i}`));
    expect(
      refusalOf([{ type: 'upsertRegion', region: region('r0', 'B2:D9') }], tabWith({ regions: existing }))
    ).toContain('would be dropped when the sheet is read back');
  });
});

describe('planFormatOps — all or nothing', () => {
  it('plans nothing when one op of ten is bad, and names its index (#5)', () => {
    // Kills: any per-op application, and any refusal that omits the index — a
    // batch failure a model cannot locate is a batch it has to guess at.
    const applied: string[] = [];
    const ops: SheetFormatOp[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'setCellFormat',
      range: `A${i + 1}`,
      patch: i === 7 ? ({ bolt: true } as never) : { bold: true },
    }));

    try {
      for (const step of planFormatOps(ops, tabWith()).steps) applied.push(step.type);
      throw new Error('Expected a refusal.');
    } catch (error) {
      expect(error).toBeInstanceOf(SheetFormatError);
      expect((error as SheetFormatError).message).toContain('Op 7 (setCellFormat)');
      expect((error as SheetFormatError).opIndex).toBe(7);
    }

    expect(applied).toEqual([]);
  });

  it('folds a mixed batch into one plan, in request order', () => {
    const result = plan([
      { type: 'setCellFormat', range: 'A1', patch: { bold: true } },
      { type: 'clearCellFormat', range: 'A1' },
      { type: 'addConditionalRule', rule: rule('cf_1') },
      { type: 'upsertRegion', region: region('r1') },
    ]);

    expect(result.steps.map((step) => step.type)).toEqual([
      'setCellFormat',
      'clearCellFormat',
      'setConditionalRules',
      'setRegions',
    ]);
    expect(result.touchesTabFields).toBe(true);
  });
});

describe('planFormatOps — everything accepted survives the parsers (#7)', () => {
  const kinds = ['cell', 'formula', 'colorScale', 'dataBar'];
  const ranges: unknown[] = [['A1:A9'], ['A1:A9', 'C1:C9'], [], ['A1:'], 'A1:A9', ['A1:A600000']];
  const formats: unknown[] = [{ bold: true }, { background: '#fee2e2' }, {}, { bolt: true }, 'red'];
  const formulas: unknown[] = ['=A1>1', '', '   ', 42];
  const colors: unknown[] = ['#ff0000', 'red', undefined];

  const ruleCandidates: unknown[] = [];
  for (const kind of kinds) {
    for (const rangeValue of ranges) {
      for (const format of formats) {
        ruleCandidates.push({
          id: 'cf_x',
          kind,
          ranges: rangeValue,
          format,
          condition: { operator: 'greaterThan', value: '10' },
          formula: formulas[ruleCandidates.length % formulas.length],
          color: colors[ruleCandidates.length % colors.length],
          min: { type: 'min', color: colors[ruleCandidates.length % colors.length] },
          max: { type: 'max', color: '#00ff00' },
        });
      }
    }
  }

  it('accepts a mix of rules and refuses the rest, and every acceptance round-trips', () => {
    let accepted = 0;
    let refused = 0;

    for (const candidate of ruleCandidates) {
      let result: SheetFormatPlan;
      try {
        result = plan([{ type: 'addConditionalRule', rule: candidate }]);
      } catch (error) {
        expect(error).toBeInstanceOf(SheetFormatError);
        refused += 1;
        continue;
      }

      accepted += 1;
      const stored = result.conditionalFormats[0];
      // The property: nothing this validator accepts may be dropped or altered
      // by the parser that reads it back.
      expect(parseConditionalRule(stored)).toEqual(stored);
    }

    // A property test over a generator that accepts everything, or nothing,
    // proves nothing — so pin that both outcomes occur in bulk. `> 0` would be
    // satisfied by a single acceptance, which is four hand-picked examples
    // wearing a generator's clothes.
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(refused).toBeGreaterThanOrEqual(ruleCandidates.length / 2);
  });

  const regionCandidates: unknown[] = [];
  for (const range of ['A1:F', 'A1:F200', 'A1', 'A1:', '', 'ZZZZ1:ZZZZ9', 'a1:f20']) {
    for (const headerRows of [0, 1, 4, 999, 'two']) {
      for (const columns of [
        undefined,
        [{ column: 'C', role: 'currency', currency: 'usd' }],
        [{ column: 'C', role: 'money' }],
        [{ column: 'C', role: 'number', decimals: 99 }],
      ]) {
        regionCandidates.push({ id: 'r1', range, headerRows, columns, theme: 'blue' });
      }
    }
  }

  it('accepts a mix of regions and refuses the rest, and every acceptance round-trips', () => {
    let accepted = 0;
    let refused = 0;

    for (const candidate of regionCandidates) {
      let result: SheetFormatPlan;
      try {
        result = plan([{ type: 'upsertRegion', region: candidate }]);
      } catch (error) {
        expect(error).toBeInstanceOf(SheetFormatError);
        refused += 1;
        continue;
      }

      accepted += 1;
      const stored = result.regions[0];
      expect(parseRegion(stored)).toEqual(stored);
    }

    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(refused).toBeGreaterThanOrEqual(regionCandidates.length / 2);
  });

  // The other direction, and the one the read half of this epic depends on:
  // #2560 hands an agent a tab's regions through `parseRegions` so it can
  // change one field and write the list straight back. That loop only works if
  // a value which has ALREADY been through the parser is accepted here — a
  // parser fixed point must never trip the readback comparator, or reading a
  // sheet and saving it unchanged becomes an error.
  //
  // A fixed point may still be REFUSED, and enumerating the reasons turned out
  // to be the wrong way to say what matters — the list kept growing, because
  // the parsers store several things they never validate:
  //
  //   - `readRanges` keeps `"A1:"`, a truncated range `addressesOfRange` then
  //     formats nothing for, so `validateRanges` refuses it here (as it does in
  //     the panel);
  //   - `parseRegion` keeps a hue the palette lost, and the rule builders keep
  //     an anchor `readAnchor` could not read;
  //   - `parseCellFormat` keeps an unknown format field, which the by-name
  //     check then refuses, so a rule written by a newer build can be edited
  //     but not cloned.
  //
  // All of those are the module doing its job. The invariant is narrower and
  // exact: a parser fixed point must never be refused for a FIDELITY reason.
  // The comparator exists to catch what the parser would rewrite, and it cannot
  // have anything to say about a value the parser itself produced — if it ever
  // does, reading a sheet and saving it back unchanged becomes an error.
  const fidelityRefusal = /would be dropped or changed on the way in/;

  it('accepts anything that has already been through parseConditionalRule', () => {
    let checked = 0;
    for (const candidate of ruleCandidates) {
      const parsed = parseConditionalRule(candidate);
      if (!parsed) continue;

      checked += 1;
      try {
        expect(plan([{ type: 'addConditionalRule', rule: parsed }]).conditionalFormats[0]).toEqual(parsed);
      } catch (error) {
        if (!(error instanceof SheetFormatError)) throw error;
        expect(error.message).not.toMatch(fidelityRefusal);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('accepts anything that has already been through parseRegion', () => {
    let checked = 0;
    for (const candidate of regionCandidates) {
      const parsed = parseRegion(candidate);
      if (!parsed) continue;

      checked += 1;
      try {
        expect(plan([{ type: 'upsertRegion', region: parsed }]).regions[0]).toEqual(parsed);
      } catch (error) {
        if (!(error instanceof SheetFormatError)) throw error;
        expect(error.message).not.toMatch(fidelityRefusal);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

describe('planFormatOps — refuses, never crashes', () => {
  // The point of `SheetFormatError` is that a caller can answer 400 to it. A
  // TypeError escaping this module answers 500 instead, and a validation layer
  // that crashes on the input it exists to reject is worse than none: the
  // caller learns nothing and the error looks like a server fault.
  //
  // Seeded rather than random so a failure is reproducible from the message
  // alone — an intermittent fuzz failure nobody can re-run is a flake, not a
  // finding.
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const OP_TYPES = [
    'setCellFormat',
    'clearCellFormat',
    'setColumnFormat',
    'setColumnWidth',
    'setRowHeight',
    'setFrozen',
    'addConditionalRule',
    'updateConditionalRule',
    'removeConditionalRule',
    'moveConditionalRule',
    'clearConditionalRules',
    'setRegions',
    'upsertRegion',
    'removeRegion',
    'setCellFromat',
    '',
  ];

  // Deliberately includes prototype-reaching keys and the shapes the parsers
  // treat specially: a blank string, a null, a lone `-1`.
  const SCALARS: unknown[] = [
    0, 1, -1, 1.5, NaN, Infinity, 5_000_002, '', '  ', 'A1', 'a1:f', 'A1:', 'B2:D40', '#ff0000',
    'red', 'bold', 'cell', 'formula', 'colorScale', 'dataBar', 'min', 'text', 'currency', true,
    false, null, undefined, '__proto__', 'constructor',
  ];
  const KEYS = [
    'id', 'kind', 'ranges', 'range', 'format', 'formula', 'condition', 'operator', 'value', 'color',
    'min', 'mid', 'max', 'column', 'columns', 'role', 'width', 'height', 'row', 'rows', 'patch',
    'regions', 'region', 'rule', 'direction', 'theme', 'headerRows', 'totalRows', 'bold', 'bolt',
    'fontSize', '__proto__', 'type',
  ];

  const value = (rand: () => number, depth: number): unknown => {
    const roll = rand();
    if (depth > 2 || roll < 0.55) return SCALARS[Math.floor(rand() * SCALARS.length)];
    if (roll < 0.75) {
      return Array.from({ length: Math.floor(rand() * 4) }, () => value(rand, depth + 1));
    }
    const object: Record<string, unknown> = {};
    for (let i = Math.floor(rand() * 5); i > 0; i--) {
      object[KEYS[Math.floor(rand() * KEYS.length)]] = value(rand, depth + 1);
    }
    return object;
  };

  it('answers every shape of garbage with a SheetFormatError or a valid plan', () => {
    const tab = tabWith({ conditionalFormats: [rule('a')], regions: [region('r1')] });
    let refusals = 0;
    let plans = 0;

    for (let seed = 0; seed < 600; seed++) {
      const rand = seeded(seed);
      const generated = value(rand, 1);
      // Give roughly half the cases a real op type, so the generator spends its
      // budget inside the handlers rather than bouncing off the type check.
      // Spread rather than assigned: half of what the generator produces is a
      // primitive, and writing a property onto one throws in strict mode — a
      // crash in the test, indistinguishable in the output from the crash in
      // the module this is looking for.
      const typed =
        rand() < 0.5
          ? {
              ...(typeof generated === 'object' && generated !== null && !Array.isArray(generated)
                ? generated
                : {}),
              type: OP_TYPES[Math.floor(rand() * OP_TYPES.length)],
            }
          : generated;
      const op = typed as SheetFormatOp;

      try {
        const result = planFormatOps([op], tab);
        plans += 1;
        expect(Array.isArray(result.steps)).toBe(true);
        expect(result.rows).toBeInstanceOf(Set);
      } catch (error) {
        if (!(error instanceof SheetFormatError)) {
          throw new Error(`seed ${seed} threw ${String(error)} for ${JSON.stringify(op)}`);
        }
        refusals += 1;
        expect(error.message).not.toBe('');
      }
    }

    // Both outcomes have to occur, or the generator is only exercising one
    // door. Plans are the rarer one — most random shapes are not valid ops.
    expect(refusals).toBeGreaterThan(100);
    expect(plans).toBeGreaterThan(0);
  });
});
