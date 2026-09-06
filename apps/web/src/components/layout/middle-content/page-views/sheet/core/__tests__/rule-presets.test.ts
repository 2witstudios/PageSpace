import { describe, it, expect } from 'vitest';
import type { ConditionalCondition, ConditionalRule } from '@pagespace/lib/sheets/sheet';
import {
  KIND_LABELS,
  OPERATOR_LABELS,
  RANGE_OPERATORS,
  VALUELESS_OPERATORS,
  describeCondition,
  describeRule,
  newRule,
  type RuleKind,
} from '../rule-presets';

describe('newRule', () => {
  it.each(['cell', 'formula', 'colorScale', 'dataBar'] as const)(
    'builds a usable %s rule over the given ranges',
    (kind) => {
      const rule = newRule(kind, ['B2:B20']);
      expect(rule.kind).toBe(kind);
      expect(rule.ranges).toEqual(['B2:B20']);
      expect(rule.id).not.toBe('');
    },
  );

  it('gives every kind in the panel a preset', () => {
    // A kind offered in the dropdown with no preset would add nothing when
    // picked, which looks like a broken button.
    for (const entry of KIND_LABELS) {
      expect(newRule(entry.value, ['A1']).kind).toBe(entry.value);
    }
  });

  it('starts a single-colour rule on a comparison the user still has to fill in', () => {
    const rule = newRule('cell', ['A1']);
    expect(rule).toMatchObject({
      kind: 'cell',
      condition: { operator: 'greaterThan', value: '' },
    });
  });

  it('starts a colour scale with both end colours set', () => {
    // Without both, the rule parses to nothing and the scale is invisible.
    const rule = newRule('colorScale', ['A1:A9']);
    expect(rule.kind === 'colorScale' && rule.min.color).toBeTruthy();
    expect(rule.kind === 'colorScale' && rule.max.color).toBeTruthy();
  });

  it('starts a data bar with a colour', () => {
    const rule = newRule('dataBar', ['A1:A9']);
    expect(rule.kind === 'dataBar' && /^#[0-9a-f]{6}$/.test(rule.color)).toBe(true);
  });

  it('gives each rule its own id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRule('cell', ['A1']).id));
    expect(ids.size).toBe(50);
  });

  it('falls back to a single-colour rule for an unknown kind', () => {
    // Defensive: a kind arriving from somewhere other than the dropdown should
    // not produce a rule with no shape at all.
    expect(newRule('nonsense' as RuleKind, ['A1']).kind).toBe('cell');
  });
});

describe('describeCondition', () => {
  it('reads a comparison as a sentence', () => {
    expect(describeCondition({ operator: 'greaterThan', value: '100' })).toBe(
      'is greater than 100',
    );
  });

  it.each([...VALUELESS_OPERATORS])('omits the value for %s', (operator) => {
    const described = describeCondition({ operator });
    expect(described).not.toContain('?');
    expect(described).toBe(
      OPERATOR_LABELS.find((entry) => entry.value === operator)?.label,
    );
  });

  it.each([...RANGE_OPERATORS])('names both bounds for %s', (operator) => {
    expect(describeCondition({ operator, value: '1', value2: '9' })).toContain('1 and 9');
  });

  it('marks a bound the user has not filled in yet', () => {
    // Better than reading "is between  and " as though it were configured.
    expect(describeCondition({ operator: 'between', value: '1' })).toContain('?');
    expect(describeCondition({ operator: 'greaterThan' })).toContain('?');
  });

  it('marks both bounds when neither is filled in', () => {
    expect(describeCondition({ operator: 'between' })).toBe('is between ? and ?');
  });

  it('falls back to the raw operator when it has no label', () => {
    // An operator added to the union but not to OPERATOR_LABELS should still
    // render as something, rather than "undefined", in the rule list.
    expect(
      describeCondition({ operator: 'sortOfGreaterThan' as ConditionalCondition['operator'] })
    ).toContain('sortOfGreaterThan');
  });

  it('reads a text comparison', () => {
    expect(describeCondition({ operator: 'contains', value: 'urgent' })).toBe(
      'contains urgent',
    );
  });
});

describe('describeRule', () => {
  const base = { id: 'r', ranges: ['A1:A9'] };

  it('describes a single-colour rule by its condition', () => {
    expect(
      describeRule({
        ...base, kind: 'cell',
        condition: { operator: 'isEmpty' }, format: {},
      }),
    ).toBe('Cell is empty');
  });

  it('describes a formula rule by its formula', () => {
    expect(describeRule({ ...base, kind: 'formula', formula: '=A1>1', format: {} }))
      .toBe('Formula =A1>1');
  });

  it('says so when a formula rule has no formula yet', () => {
    expect(describeRule({ ...base, kind: 'formula', formula: '', format: {} }))
      .toBe('Formula (not set)');
  });

  it('distinguishes a two- and three-colour scale', () => {
    const two: ConditionalRule = {
      ...base, kind: 'colorScale',
      min: { type: 'min', color: '#ffffff' },
      max: { type: 'max', color: '#000000' },
    };
    expect(describeRule(two)).toBe('Colour scale');
    expect(describeRule({ ...two, mid: { type: 'percentile', value: 50, color: '#ff0000' } }))
      .toContain('3 colours');
  });

  it('describes a data bar', () => {
    expect(describeRule({ ...base, kind: 'dataBar', color: '#3b82f6' })).toBe('Data bar');
  });
});

describe('the operator lists agree with each other', () => {
  it('labels every operator the panel offers', () => {
    // An operator in the union with no label renders as its raw identifier.
    for (const operator of [...VALUELESS_OPERATORS, ...RANGE_OPERATORS]) {
      expect(OPERATOR_LABELS.some((entry) => entry.value === operator)).toBe(true);
    }
  });

  it('does not mark an operator both valueless and range-bounded', () => {
    for (const operator of VALUELESS_OPERATORS) {
      expect(RANGE_OPERATORS.has(operator)).toBe(false);
    }
  });
});
