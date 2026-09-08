/**
 * The rule shapes the panel offers, and how to describe one in a list.
 *
 * Kept out of the component so the wording and the defaults are testable, and
 * so "what does this rule do?" has one answer rather than one per render path.
 */

import type {
  ConditionalOperator,
  ConditionalRule,
  ConditionalCondition,
} from '@pagespace/lib/sheets/sheet';
import { newRuleId } from './conditional-ops';
import { rangeAnchor } from '@pagespace/lib/sheets/sheet';
import { encodeCellAddress } from '@pagespace/lib/sheets/sheet';

/** Operators, in the order a panel should list them, with plain-language labels. */
export const OPERATOR_LABELS: ReadonlyArray<{ value: ConditionalOperator; label: string }> = [
  { value: 'greaterThan', label: 'is greater than' },
  { value: 'greaterThanOrEqual', label: 'is greater than or equal to' },
  { value: 'lessThan', label: 'is less than' },
  { value: 'lessThanOrEqual', label: 'is less than or equal to' },
  { value: 'equal', label: 'is equal to' },
  { value: 'notEqual', label: 'is not equal to' },
  { value: 'between', label: 'is between' },
  { value: 'notBetween', label: 'is not between' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
  { value: 'isError', label: 'is an error' },
];

/**
 * Re-exported, not defined here any more.
 *
 * The server-side write path has to refuse a `greaterThan` rule with no value
 * for the same reason the panel hides the field for `isEmpty` — it is part of
 * what a valid rule IS, not a rendering detail. Two copies of that answer is
 * how the API comes to accept a rule this panel would never offer, so the
 * definition moved to `@pagespace/lib/sheets` and both sides read it from
 * there. Kept as re-exports so every existing importer of this module is
 * untouched.
 */
export { VALUELESS_OPERATORS, RANGE_OPERATORS } from '@pagespace/lib/sheets/sheet';

export type RuleKind = ConditionalRule['kind'];

export const KIND_LABELS: ReadonlyArray<{ value: RuleKind; label: string; hint: string }> = [
  { value: 'cell', label: 'Single colour', hint: 'Format cells that match a condition' },
  { value: 'formula', label: 'Custom formula', hint: 'Format cells where a formula is true' },
  { value: 'colorScale', label: 'Colour scale', hint: 'Shade cells across a gradient' },
  { value: 'dataBar', label: 'Data bar', hint: 'Draw a bar in proportion to the value' },
];

/** A sensible starting rule of each kind, over the given ranges. */
export function newRule(kind: RuleKind, ranges: string[]): ConditionalRule {
  const id = newRuleId();

  switch (kind) {
    case 'formula': {
      // A blank formula is REJECTED by parseConditionalRule, so persisting one
      // creates a rule that shows up now and is gone after a reload — the exact
      // disappearance the ceilings elsewhere refuse to allow. Start from a
      // valid formula anchored to the range's top-left, which is both
      // immediately meaningful and obviously the thing to edit.
      const anchor = rangeAnchor(ranges[0] ?? '') ?? { row: 0, column: 0 };
      const cell = encodeCellAddress(anchor.row, anchor.column);
      return { id, kind, ranges, formula: `=${cell}>0`, format: { background: '#fef3c7' } };
    }
    case 'colorScale':
      return {
        id,
        kind,
        ranges,
        min: { type: 'min', color: '#ffffff' },
        max: { type: 'max', color: '#22c55e' },
      };
    case 'dataBar':
      return { id, kind, ranges, color: '#3b82f6' };
    case 'cell':
    default:
      return {
        id,
        kind: 'cell',
        ranges,
        condition: { operator: 'greaterThan', value: '' },
        format: { background: '#fee2e2' },
      };
  }
}

const operatorLabel = (operator: ConditionalOperator): string =>
  OPERATOR_LABELS.find((entry) => entry.value === operator)?.label ?? operator;

/** How a condition reads in a rule list: "is greater than 100". */
export function describeCondition(condition: ConditionalCondition): string {
  const label = operatorLabel(condition.operator);
  if (VALUELESS_OPERATORS.has(condition.operator)) return label;
  if (RANGE_OPERATORS.has(condition.operator)) {
    return `${label} ${condition.value || '?'} and ${condition.value2 || '?'}`;
  }
  return `${label} ${condition.value || '?'}`;
}

/** A one-line summary of a rule, for the list row. */
export function describeRule(rule: ConditionalRule): string {
  switch (rule.kind) {
    case 'cell':
      return `Cell ${describeCondition(rule.condition)}`;
    case 'formula':
      return rule.formula ? `Formula ${rule.formula}` : 'Formula (not set)';
    case 'colorScale':
      return rule.mid ? 'Colour scale (3 colours)' : 'Colour scale';
    case 'dataBar':
      return 'Data bar';
  }
}
