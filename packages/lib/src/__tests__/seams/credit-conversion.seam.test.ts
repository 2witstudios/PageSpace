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
 * Measured on 2026-09-15 (lane A4) before money-model.ts existed: the web and marketing
 * copy helpers each defined a conversion. Lane A1 (MON-5) moved them onto money-model.ts
 * and emptied this list. Nothing may be added back.
 */
export const CREDIT_CONVERSION_ALLOWLIST: Readonly<Record<string, string>> = {
  // Lane A1 (MON-5) landed money-model.ts; the web and marketing copy helpers are thin
  // re-exports of it now, so nothing is allowlisted.
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

/**
 * Seam guard 3 — D-OW-17: the money-model ratio switch is a CODE CONSTANT
 * (`MONEY_MODEL_V2_ACTIVE` in money-model.ts), never a runtime env var. A prior
 * revision of this fix used `process.env.MONEY_MODEL_V2` on the server, then a
 * `NEXT_PUBLIC_MONEY_MODEL_V2` client mirror — both rejected as a "two flags must
 * agree" footgun (the mirror can drift from the server value; a cross-app env
 * pair can drift the same way). A compile-time constant is the only value
 * guaranteed identical across every process (web, marketing, and every client
 * bundle) without runtime coordination — so the env var must never come back,
 * anywhere, including inside money-model.ts itself.
 *
 * The pattern matches the bare `process.env.MONEY_MODEL_V2` accessor AND the
 * string literal `'MONEY_MODEL_V2'` / `"MONEY_MODEL_V2"` / `` `MONEY_MODEL_V2` ``
 * (all three quote characters — single, double, and template-literal
 * backtick) wherever it appears — not just as a `process.env` property, but
 * as an argument to ANY accessor (`envBool('MONEY_MODEL_V2', …)`,
 * `envInt(...)`, a config-lookup helper, etc). A first version of this guard
 * only matched `process.env.MONEY_MODEL_V2` and missed
 * `envBool('MONEY_MODEL_V2', false)` — the exact form D-OW-17 deleted —
 * because that call site never writes `process.env` at all. A second version
 * added the string-literal form but only for `'` and `"`, missing the
 * backtick template-literal form (`` envBool(`MONEY_MODEL_V2`, false) ``).
 *
 * The allowlist is intentionally EMPTY: after this refactor no production file
 * reads this var. (money-model.test.ts itself briefly SETS `process.env.MONEY_MODEL_V2`,
 * in one test, to prove that doing so has no effect — that file lives in a
 * __tests__ directory, which listSourceFiles always excludes, so it never
 * reaches this seam. money-model.ts's own doc comment mentions the string in
 * prose, but only inside its top block comment, which findViolations strips
 * before matching — no allowlist entry is needed for it either.)
 */
export const MONEY_MODEL_ENV_READ =
  /process\.env(?:\.MONEY_MODEL_V2\b|\[['"`]MONEY_MODEL_V2['"`]\])|(['"`])MONEY_MODEL_V2\1/;

export const MONEY_MODEL_ENV_ALLOWLIST: Readonly<Record<string, string>> = {};

describe('D-OW-17 seam: the money-model ratio flag is a code constant, never a runtime env var', () => {
  const result = runSeam({
    files: listSourceFiles(['apps', 'packages']),
    pattern: MONEY_MODEL_ENV_READ,
    exemptPrefixes: [],
    allowlist: MONEY_MODEL_ENV_ALLOWLIST,
  });

  it('D-OW-17 no file (production or otherwise) reads process.env.MONEY_MODEL_V2', () => {
    expect(
      result.newViolations,
      `process.env.MONEY_MODEL_V2 must never be read — flip MONEY_MODEL_V2_ACTIVE ` +
        `in ${MONEY_MODEL_PATH} instead (D-OW-17):\n` +
        describeViolations(result.newViolations),
    ).toEqual([]);
  });

  it('D-OW-17 the allowlist stays empty (the env var never comes back)', () => {
    expect(result.staleAllowlist).toEqual([]);
    expect(Object.keys(MONEY_MODEL_ENV_ALLOWLIST)).toEqual([]);
  });

  it('D-OW-17 the pattern matches both dot and bracket property access on process.env', () => {
    expect(MONEY_MODEL_ENV_READ.test("process.env.MONEY_MODEL_V2 === 'true'")).toBe(true);
    expect(MONEY_MODEL_ENV_READ.test('process.env["MONEY_MODEL_V2"]')).toBe(true);
    expect(MONEY_MODEL_ENV_READ.test("process.env['MONEY_MODEL_V2']")).toBe(true);
    expect(MONEY_MODEL_ENV_READ.test('process.env.MONEY_MODEL_V2_ACTIVE')).toBe(false);
    expect(MONEY_MODEL_ENV_READ.test('const x = MONEY_MODEL_V2_ACTIVE;')).toBe(false);
  });

  it('D-OW-17 the pattern also matches the bare string literal passed to ANY accessor, not just process.env', () => {
    // The exact form D-OW-17 deleted, and the exact false-negative a reviewer
    // proved against the first version of this guard.
    expect(MONEY_MODEL_ENV_READ.test("envBool('MONEY_MODEL_V2', false)")).toBe(true);
    expect(MONEY_MODEL_ENV_READ.test('envBool("MONEY_MODEL_V2", false)')).toBe(true);
    expect(MONEY_MODEL_ENV_READ.test("getFlag('MONEY_MODEL_V2')")).toBe(true);
    // Point-guard's second false-negative: a backtick template-literal string
    // argument (no interpolation, just a plain backtick string) was invisible
    // to the ['"] quote class.
    expect(MONEY_MODEL_ENV_READ.test('envBool(`MONEY_MODEL_V2`, false)')).toBe(true);
    // A quote must close immediately after V2 — MONEY_MODEL_V2_ACTIVE, quoted or
    // not, never matches.
    expect(MONEY_MODEL_ENV_READ.test("envBool('MONEY_MODEL_V2_ACTIVE', false)")).toBe(false);
    expect(MONEY_MODEL_ENV_READ.test('envBool(`MONEY_MODEL_V2_ACTIVE`, false)')).toBe(false);
    expect(MONEY_MODEL_ENV_READ.test('const flag = MONEY_MODEL_V2_ACTIVE;')).toBe(false);
    // Mismatched quote characters never match — not a real string literal.
    expect(MONEY_MODEL_ENV_READ.test("envBool('MONEY_MODEL_V2\", false)")).toBe(false);
    expect(MONEY_MODEL_ENV_READ.test('envBool(`MONEY_MODEL_V2\', false)')).toBe(false);
  });
});
