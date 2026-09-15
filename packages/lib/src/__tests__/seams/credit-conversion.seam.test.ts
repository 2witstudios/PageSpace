/**
 * Seam guard 2 — one credit conversion (Spec MON-5: "A test greps for any second conversion
 * and fails on it").
 *
 * A credit is defined once, in packages/lib/src/billing/money-model.ts (lane A1). Any other
 * DEFINITION of a cents↔credits or dollars↔credits conversion — a named function or a
 * named constant — is a second path and a bug. Today's definitions (pre-money-model, in the
 * web and marketing copy helpers) are measured and allowlisted with the lane that removes
 * them; a NEW definition anywhere else fails this test.
 *
 * Lane A1: when money-model.ts lands and the callers below move onto it, delete their
 * allowlist entries here (the stale-allowlist assertion will remind you) rather than
 * adding a second grep.
 */
import { describe, expect, it } from 'vitest';
import { describeViolations, listSourceFiles, runSeam } from './walk';

/**
 * A DEFINITION (not a call) of a conversion between cents/dollars and credits, by name.
 * Calls are fine — callers are supposed to import the one definition.
 */
export const CREDIT_CONVERSION_DEFINITION =
  /\b(?:export\s+)?(?:async\s+)?(?:function|const|let)\s+(?:centsToCredits|creditsToCents|dollarsToCredits|creditsToDollars|toDisplayCredits|formatCreditUnits\w*|formatCreditCount\w*|formatCredits?|CREDITS_PER_DOLLAR|CENTS_PER_CREDIT|CREDIT_CENTS|MICROCREDITS_PER_CREDIT)\b/;

/** The one canonical home. */
export const MONEY_MODEL_PATH = 'packages/lib/src/billing/money-model.ts';

/**
 * Measured on 2026-09-15 (lane A4), before money-model.ts exists. Owner: lane A1 (MON-5)
 * moves each onto the money-model module and removes the entry.
 */
export const CREDIT_CONVERSION_ALLOWLIST: Readonly<Record<string, string>> = {
  "apps/web/src/lib/subscription/credits.ts":
    "TODO(OW-A1 MON-5): in-app credit copy helpers (centsToCredits, toDisplayCredits, formatCreditUnits*, formatCreditCount*) move onto money-model.ts",
  "apps/marketing/src/lib/credits.ts":
    "TODO(OW-A1 MON-5): marketing mirror (formatCredits) moves onto money-model.ts",
};

describe('X-6 seam: a credit is converted in one module (the Spec second-conversion grep)', () => {
  const result = runSeam({
    files: listSourceFiles(['apps', 'packages']),
    pattern: CREDIT_CONVERSION_DEFINITION,
    exemptPrefixes: [MONEY_MODEL_PATH],
    allowlist: CREDIT_CONVERSION_ALLOWLIST,
  });

  it('X-6 no NEW file defines a cents/dollars to credits conversion outside money-model.ts', () => {
    expect(
      result.newViolations,
      `Second credit conversion found. Import from ${MONEY_MODEL_PATH} instead:\n` +
        describeViolations(result.newViolations),
    ).toEqual([]);
  });

  it('X-6 every allowlisted conversion file still defines one (the allowlist only shrinks)', () => {
    expect(
      result.staleAllowlist,
      'These allowlisted files no longer define a conversion — remove them from CREDIT_CONVERSION_ALLOWLIST',
    ).toEqual([]);
  });

  it('X-6 the pattern matches definitions and ignores calls', () => {
    expect(CREDIT_CONVERSION_DEFINITION.test('export function centsToCredits(cents: number) {')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('function formatCredits(cents: number): string {')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('export const CREDITS_PER_DOLLAR = 100;')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('const credits = centsToCredits(topup.remaining);')).toBe(false);
    expect(CREDIT_CONVERSION_DEFINITION.test("import { formatCreditCount } from '@pagespace/lib/billing/money-model';")).toBe(false);
  });
});
