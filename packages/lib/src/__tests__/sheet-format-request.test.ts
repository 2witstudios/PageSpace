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
import { MAX_REGIONS, parseRegion, type SheetRegion } from '../sheets/regions';

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
    ['past the last row', 5_000_001],
  ])('refuses a row height addressed at %s', (_label, row) => {
    expect(refusalOf([{ type: 'setRowHeight', row, height: 40 }])).toContain('1-based row number');
  });

  it('plans a freeze inside the sheet extent', () => {
    const result = plan([{ type: 'setFrozen', rows: 1, columns: null }]);
    expect(result.steps).toEqual([{ type: 'setFrozen', rows: 1, columns: undefined }]);
    expect(result.touchesTabFields).toBe(true);
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
      'not a rule this sheet can store'
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
    ).toContain('cannot store');
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

  it('clears every rule', () => {
    const tab = tabWith({ conditionalFormats: [rule('a')] });
    const result = plan([{ type: 'clearConditionalRules' }], tab);
    expect(result.conditionalFormats).toEqual([]);
    expect(result.steps).toEqual([{ type: 'setConditionalRules', rules: [] }]);
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
    // proves nothing — so pin that both outcomes actually occur.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
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

    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
