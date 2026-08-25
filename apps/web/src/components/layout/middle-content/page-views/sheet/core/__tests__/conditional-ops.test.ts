import { describe, it, expect } from 'vitest';
import { createEmptySheet, type ConditionalRule, type SheetData } from '@pagespace/lib/sheets/sheet';
import {
  addRule,
  defaultRuleRange,
  moveRule,
  newRuleId,
  removeRule,
  updateRule,
} from '../conditional-ops';

const rule = (id: string, over = '10'): ConditionalRule => ({
  id,
  kind: 'cell',
  ranges: ['A1:A9'],
  condition: { operator: 'greaterThan', value: over },
  format: { background: '#fee2e2' },
});

const sheetWith = (...rules: ConditionalRule[]): SheetData => ({
  ...createEmptySheet(),
  ...(rules.length > 0 ? { conditionalFormats: rules } : {}),
});

describe('addRule', () => {
  it('appends, so a new rule layers over what is already there', () => {
    const next = addRule(sheetWith(rule('a')), rule('b'));
    expect(next.conditionalFormats?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('starts the list on a sheet that had none', () => {
    expect(addRule(sheetWith(), rule('a')).conditionalFormats).toHaveLength(1);
  });

  it('bumps the version so the change is persisted', () => {
    const sheet = sheetWith();
    expect(addRule(sheet, rule('a')).version).toBe(sheet.version + 1);
  });
});

describe('updateRule', () => {
  it('replaces a rule in place, keeping its precedence', () => {
    const next = updateRule(sheetWith(rule('a'), rule('b')), 'a', { ranges: ['B1:B9'] });
    expect(next.conditionalFormats?.[0].ranges).toEqual(['B1:B9']);
    expect(next.conditionalFormats?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('refuses to let a patch change identity', () => {
    // Changing `id` or `kind` under the panel would detach the rule from the
    // row being edited, and `kind` decides which fields even apply.
    const next = updateRule(sheetWith(rule('a')), 'a', {
      id: 'hijacked',
      kind: 'dataBar',
    } as Partial<ConditionalRule>);
    expect(next.conditionalFormats?.[0].id).toBe('a');
    expect(next.conditionalFormats?.[0].kind).toBe('cell');
  });

  it('returns the sheet untouched for an id it does not hold', () => {
    const sheet = sheetWith(rule('a'));
    expect(updateRule(sheet, 'missing', { ranges: ['Z1'] })).toBe(sheet);
  });
});

describe('removeRule', () => {
  it('drops the rule', () => {
    expect(removeRule(sheetWith(rule('a'), rule('b')), 'a').conditionalFormats?.map((r) => r.id))
      .toEqual(['b']);
  });

  it('clears the field entirely when the last rule goes', () => {
    // Rather than leaving an empty array, which would serialize as a bag with
    // nothing in it.
    expect(removeRule(sheetWith(rule('a')), 'a').conditionalFormats).toBeUndefined();
  });

  it('returns the sheet untouched for an id it does not hold', () => {
    const sheet = sheetWith(rule('a'));
    expect(removeRule(sheet, 'missing')).toBe(sheet);
  });
});

describe('moveRule', () => {
  it('moves a rule down, changing which one wins', () => {
    const next = moveRule(sheetWith(rule('a'), rule('b'), rule('c')), 'a', 1);
    expect(next.conditionalFormats?.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves a rule up', () => {
    const next = moveRule(sheetWith(rule('a'), rule('b')), 'b', -1);
    expect(next.conditionalFormats?.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('is a no-op at either end, so the buttons push no undo entry', () => {
    const sheet = sheetWith(rule('a'), rule('b'));
    expect(moveRule(sheet, 'a', -1)).toBe(sheet);
    expect(moveRule(sheet, 'b', 1)).toBe(sheet);
  });

  it('returns the sheet untouched for an id it does not hold', () => {
    const sheet = sheetWith(rule('a'));
    expect(moveRule(sheet, 'missing', 1)).toBe(sheet);
  });
});

describe('newRuleId', () => {
  it('does not collide across rapid creation', () => {
    // A counter would repeat across two tabs of the same sheet.
    const ids = new Set(Array.from({ length: 500 }, () => newRuleId()));
    expect(ids.size).toBe(500);
  });
});

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
