/**
 * Pure rule mutation for the conditional-formatting panel.
 *
 * The same shape as `format-commands`: a panel action becomes a value, and one
 * function turns it into the next `SheetData`. Keeping it here rather than in
 * click handlers is what makes rule ordering — which is load-bearing, since
 * later rules layer over earlier ones — testable without a component.
 */

import type { ConditionalRule, SheetData } from '@pagespace/lib/sheets/sheet';
import { getSelectionAddress, type SelectionState } from './selection';

/** Rule ids are opaque; a counter would collide across two tabs of one sheet. */
export const newRuleId = (): string =>
  `cf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const withRules = (sheet: SheetData, rules: ConditionalRule[]): SheetData => ({
  ...sheet,
  version: sheet.version + 1,
  conditionalFormats: rules.length > 0 ? rules : undefined,
});

/** Append a rule. New rules go last, so they layer over what is already there. */
export const addRule = (sheet: SheetData, rule: ConditionalRule): SheetData =>
  withRules(sheet, [...(sheet.conditionalFormats ?? []), rule]);

/** Replace one rule by id, leaving its position — and so its precedence — alone. */
export const updateRule = (
  sheet: SheetData,
  id: string,
  patch: Partial<ConditionalRule>,
): SheetData => {
  const rules = sheet.conditionalFormats ?? [];
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return sheet;

  const next = [...rules];
  // `id` and `kind` are identity, not settings: letting a patch change either
  // would silently detach the rule from the row the panel is editing.
  //
  // The cast asserts exactly that invariant. TypeScript cannot see that
  // spreading a partial over a union member leaves it in the same arm, but
  // pinning `kind` here is what makes it true.
  next[index] = {
    ...next[index],
    ...patch,
    id: next[index].id,
    kind: next[index].kind,
  } as ConditionalRule;
  return withRules(sheet, next);
};

export const removeRule = (sheet: SheetData, id: string): SheetData => {
  const rules = sheet.conditionalFormats ?? [];
  const next = rules.filter((rule) => rule.id !== id);
  return next.length === rules.length ? sheet : withRules(sheet, next);
};

/**
 * Move a rule up or down the list, which is how its precedence is changed.
 * Returns the sheet unchanged at either end, so the panel's buttons can be
 * pressed without pushing an empty entry onto the undo stack.
 */
export const moveRule = (sheet: SheetData, id: string, direction: -1 | 1): SheetData => {
  const rules = sheet.conditionalFormats ?? [];
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return sheet;

  const target = index + direction;
  if (target < 0 || target >= rules.length) return sheet;

  const next = [...rules];
  [next[index], next[target]] = [next[target], next[index]];
  return withRules(sheet, next);
};

/** The A1 range a new rule should default to: whatever is selected. */
export const defaultRuleRange = (selection: SelectionState): string =>
  getSelectionAddress(selection);
