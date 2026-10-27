/**
 * Rule mutation for the conditional-formatting panel.
 *
 * The rule operations themselves live in `@pagespace/lib/sheets/conditional-ops`
 * so the panel and the server refuse exactly the same things. Only
 * `defaultRuleRange` stays here, because it reads the grid's selection — which
 * is a UI concept the lib has no business knowing about.
 */

export {
  addRule,
  moveRule,
  newRuleId,
  removeRule,
  updateRule,
  validateRanges,
  type RuleRefusal,
  type RuleResult,
} from '@pagespace/lib/sheets/sheet';

import { getSelectionAddress, type SelectionState } from './selection';

/** The A1 range a new rule should default to: whatever is selected. */
export const defaultRuleRange = (selection: SelectionState): string =>
  getSelectionAddress(selection);
