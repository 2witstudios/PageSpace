import { describe, it, expect } from 'vitest';
import { createEmptySheet } from '../sheets/io';
import type { ConditionalRule } from '../sheets/conditional';
import type { SheetData } from '../sheets/types';
import { MAX_CONDITIONAL_RANGES_PER_RULE, MAX_CONDITIONAL_RULES } from '../sheets/conditional';
import {
  addRule,
  moveRule,
  newRuleId,
  removeRule,
  updateRule,
  validateRanges,
} from '../sheets/conditional-ops';

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

/** addRule refuses rather than returning a sheet, so unwrap where it succeeds. */
const added = (sheet: SheetData, r: ConditionalRule): SheetData => {
  const result = addRule(sheet, r);
  if (!result.ok) throw new Error(`expected the rule to be accepted: ${result.reason}`);
  return result.sheet;
};

describe('addRule', () => {
  it('appends, so a new rule layers over what is already there', () => {
    expect(added(sheetWith(rule('a')), rule('b')).conditionalFormats?.map((r) => r.id))
      .toEqual(['a', 'b']);
  });

  it('starts the list on a sheet that had none', () => {
    expect(added(sheetWith(), rule('a')).conditionalFormats).toHaveLength(1);
  });

  it('bumps the version so the change is persisted', () => {
    const sheet = sheetWith();
    expect(added(sheet, rule('a')).version).toBe(sheet.version + 1);
  });

  it('refuses past the rule ceiling, with a reason worth showing', () => {
    // The parser drops rules past this on the next load. Returning a sheet here
    // would make the panel look like it worked, and the rule would be gone the
    // next time the page opened.
    const full = sheetWith(...Array.from({ length: MAX_CONDITIONAL_RULES }, (_, i) => rule(`r${i}`)));
    const result = addRule(full, rule('one-too-many'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(String(MAX_CONDITIONAL_RULES));
  });

  it('accepts the last rule that fits', () => {
    const nearlyFull = sheetWith(
      ...Array.from({ length: MAX_CONDITIONAL_RULES - 1 }, (_, i) => rule(`r${i}`))
    );
    expect(addRule(nearlyFull, rule('last')).ok).toBe(true);
  });

  it.each([
    ['an empty range list', []],
    ['an unparseable range', ['not-a-range']],
    ['a range beyond the cell ceiling', ['A1:ZZZ5000000']],
  ])('refuses %s', (_label, ranges) => {
    const result = addRule(sheetWith(), { ...rule('a'), ranges });
    expect(result.ok).toBe(false);
  });
});

describe('validateRanges', () => {
  it('accepts an ordinary range', () => {
    expect(validateRanges(['B2:B20']).ok).toBe(true);
  });

  it('names the offending range, so the panel can point at it', () => {
    const result = validateRanges(['A1:A9', 'nonsense']);
    expect(result.ok === false && result.reason).toContain('nonsense');
  });

  it('refuses more ranges than one rule may hold', () => {
    const many = Array.from({ length: MAX_CONDITIONAL_RANGES_PER_RULE + 1 }, () => 'A1');
    expect(validateRanges(many).ok).toBe(false);
  });

  it('refuses ranges that are individually fine but too big together', () => {
    // The per-range ceiling would pass each one; the sum is what evaluation pays.
    const chunky = Array.from({ length: 3 }, (_, i) => `A${i * 200000 + 1}:A${(i + 1) * 200000}`);
    expect(validateRanges(chunky).ok).toBe(false);
  });
});

/** updateRule refuses with a reason now, so unwrap where it should succeed. */
const updated = (sheet: SheetData, id: string, patch: Partial<ConditionalRule>): SheetData => {
  const result = updateRule(sheet, id, patch);
  if (!result.ok) throw new Error(`expected the patch to be accepted: ${result.reason}`);
  return result.sheet;
};

describe('updateRule', () => {
  it('refuses a patch that widens the ranges past the ceiling', () => {
    // Otherwise editing is a way around the limit that adding refuses.
    const result = updateRule(sheetWith(rule('a')), 'a', { ranges: ['A1:ZZZ5000000'] });
    expect(result.ok).toBe(false);
    // ...and says why, so the panel is not left silently restoring the old value.
    expect(result.ok === false && result.reason).toBeTruthy();
  });

  it('refuses a blank formula, which would be dropped on the next load', () => {
    const formulaRule: ConditionalRule = {
      id: 'f', kind: 'formula', ranges: ['A1:A9'], formula: '=A1>0', format: { bold: true },
    };
    const result = updateRule(sheetWith(formulaRule), 'f', { formula: '   ' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('formula');
  });

  it('replaces a rule in place, keeping its precedence', () => {
    const next = updated(sheetWith(rule('a'), rule('b')), 'a', { ranges: ['B1:B9'] });
    expect(next.conditionalFormats?.[0].ranges).toEqual(['B1:B9']);
    expect(next.conditionalFormats?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('refuses to let a patch change identity', () => {
    // Changing `id` or `kind` under the panel would detach the rule from the
    // row being edited, and `kind` decides which fields even apply.
    const next = updated(sheetWith(rule('a')), 'a', {
      id: 'hijacked',
      kind: 'dataBar',
    } as Partial<ConditionalRule>);
    expect(next.conditionalFormats?.[0].id).toBe('a');
    expect(next.conditionalFormats?.[0].kind).toBe('cell');
  });

  it('refuses an id it does not hold', () => {
    expect(updateRule(sheetWith(rule('a')), 'missing', { ranges: ['Z1'] }).ok).toBe(false);
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

describe('a sheet with no rules at all', () => {
  // Not a contrived case: the panel can be open on a sheet whose last rule was
  // just deleted, and every one of these has to be a no-op rather than throw on
  // an absent list.
  const empty = () => sheetWith();

  it('update refuses rather than throwing on an absent list', () => {
    expect(updateRule(empty(), 'anything', { ranges: ['A1'] }).ok).toBe(false);
  });

  it('remove is a no-op', () => {
    const sheet = empty();
    expect(removeRule(sheet, 'anything')).toBe(sheet);
  });

  it('move is a no-op', () => {
    const sheet = empty();
    expect(moveRule(sheet, 'anything', 1)).toBe(sheet);
    expect(moveRule(sheet, 'anything', -1)).toBe(sheet);
  });
});
