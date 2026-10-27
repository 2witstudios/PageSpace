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
import { describeViolations, listFiles, listSourceFiles, runSeam } from './walk';

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

describe('seam: a credit is converted in one module (the Spec second-conversion grep)', () => {
  const result = runSeam({
    files: listSourceFiles(['apps', 'packages']),
    pattern: CREDIT_CONVERSION_DEFINITION,
    exemptPrefixes: [MONEY_MODEL_PATH],
    allowlist: CREDIT_CONVERSION_ALLOWLIST,
  });

  it('no NEW file defines a cents/dollars to credits conversion outside money-model.ts', () => {
    expect(
      result.newViolations,
      `Second credit conversion found. Import from ${MONEY_MODEL_PATH} instead:\n` +
        describeViolations(result.newViolations),
    ).toEqual([]);
  });

  it('every allowlisted conversion file still defines one (the allowlist only shrinks)', () => {
    expect(
      result.staleAllowlist,
      'These allowlisted files no longer define a conversion — remove them from CREDIT_CONVERSION_ALLOWLIST',
    ).toEqual([]);
  });

  it('the pattern matches definitions and ignores calls', () => {
    expect(CREDIT_CONVERSION_DEFINITION.test('export function centsToCredits(cents: number) {')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('function formatCredits(cents: number): string {')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('export const CREDITS_PER_DOLLAR = 100;')).toBe(true);
    expect(CREDIT_CONVERSION_DEFINITION.test('const credits = centsToCredits(topup.remaining);')).toBe(false);
    expect(CREDIT_CONVERSION_DEFINITION.test("import { formatCreditCount } from '@pagespace/lib/billing/money-model';")).toBe(false);
  });
});

/**
 * Seam guard 3 — D-OW-17 / D-OW-42: the included-credit ratio is in force
 * unconditionally. It was staged behind a runtime env var (`MONEY_MODEL_V2`, then a
 * `NEXT_PUBLIC_` client mirror), then behind a code constant (`MONEY_MODEL_V2_ACTIVE`
 * with `isMoneyModelV2Enabled()` and a legacy 100% ratio); the migration commit
 * flipped the constant and the full cutover removed it. No switch of any of those
 * shapes may come back, anywhere, including inside money-model.ts itself.
 *
 * The pattern matches the NAMES themselves, as an identifier or inside any string,
 * wherever they appear outside a comment — not any particular accessor shape.
 * Earlier versions matched accessor shapes and each was beaten by one it did not
 * list: `envBool('MONEY_MODEL_V2', false)` (no `process.env` at all), then a backtick
 * string, then (independent review on #2649) `const { MONEY_MODEL_V2 } = process.env`,
 * an injected `env.MONEY_MODEL_V2`, and `process.env?.MONEY_MODEL_V2`.
 *
 * Scope (stated in the test names): TS/JS source of every flavour
 * (.ts/.tsx/.js/.mjs/.cjs), Dockerfiles, compose/workflow YAML and env files, under
 * apps/, packages/, scripts/, infrastructure/ and .github/. Markdown is not scanned.
 * Non-JS files have no comment stripping, so even a `#` comment naming the variable
 * fails — rename the prose rather than allowlisting it.
 *
 * The allowlist is intentionally EMPTY. (money-model.test.ts SETS
 * `process.env.MONEY_MODEL_V2` in one test to prove it has no effect, and asserts the
 * removed exports are undefined; it lives in a __tests__ directory, which the walker
 * always excludes. money-model.ts's doc comment names the removed constant in prose,
 * inside a block comment findViolations strips.)
 */
export const MONEY_MODEL_ENV_READ =
  /(?<![A-Za-z0-9_$])(?:(?:NEXT_PUBLIC_)?MONEY_MODEL_V2(?:_ACTIVE)?|isMoneyModelV2Enabled\w*|LEGACY_INCLUDED_CREDIT_RATIO_BPS)(?![A-Za-z0-9_$])/;

/** The roots and file kinds the D-OW-17 guard scans (see the scope note above). */
export const MONEY_MODEL_ENV_SCAN_ROOTS = ['apps', 'packages', 'scripts', 'infrastructure', '.github'] as const;
export const MONEY_MODEL_ENV_SCAN_FILES =
  /(?:\.(?:ts|tsx|js|mjs|cjs|ya?ml)$|^Dockerfile|\.Dockerfile$|^\.env(?:\..*)?$)/;

export const MONEY_MODEL_ENV_ALLOWLIST: Readonly<Record<string, string>> = {};

describe('D-OW-17 / D-OW-42 seam: no money-model ratio switch — neither an env var nor a code constant', () => {
  const result = runSeam({
    files: listFiles(MONEY_MODEL_ENV_SCAN_ROOTS, MONEY_MODEL_ENV_SCAN_FILES),
    pattern: MONEY_MODEL_ENV_READ,
    exemptPrefixes: [],
    allowlist: MONEY_MODEL_ENV_ALLOWLIST,
  });

  it('D-OW-17 no ts/tsx/js/mjs/cjs, Dockerfile, YAML or env file under apps, packages, scripts, infrastructure or .github names a ratio switch outside a comment', () => {
    expect(
      result.newViolations,
      `the included-credit ratio has no switch — ${MONEY_MODEL_PATH} states it unconditionally (D-OW-17, D-OW-42):\n` +
        describeViolations(result.newViolations),
    ).toEqual([]);
  });

  it('D-OW-17 the allowlist stays empty (no switch comes back)', () => {
    expect(result.staleAllowlist).toEqual([]);
    expect(Object.keys(MONEY_MODEL_ENV_ALLOWLIST)).toEqual([]);
  });

  it('D-OW-17 the scan covers every file kind it names, and still skips tests', () => {
    for (const name of ['a.ts', 'a.tsx', 'next.config.js', 'a.mjs', 'a.cjs', 'ci.yml', 'compose.yaml', 'Dockerfile', 'Dockerfile.web', 'web.Dockerfile', '.env', '.env.example']) {
      expect(MONEY_MODEL_ENV_SCAN_FILES.test(name), name).toBe(true);
    }
    expect(MONEY_MODEL_ENV_SCAN_FILES.test('README.md')).toBe(false);
    const scanned = listFiles(MONEY_MODEL_ENV_SCAN_ROOTS, MONEY_MODEL_ENV_SCAN_FILES);
    expect(scanned.some((f) => f.startsWith('.github/workflows/'))).toBe(true);
    expect(scanned.some((f) => /\.(?:mjs|js|cjs)$/.test(f))).toBe(true);
    expect(scanned.some((f) => /(^|\/)Dockerfile/.test(f))).toBe(true);
    expect(scanned.some((f) => f.includes('/__tests__/'))).toBe(false);
  });

  it.each([
    ["process.env.MONEY_MODEL_V2 === 'true'"],
    ['process.env["MONEY_MODEL_V2"]'],
    ["process.env['MONEY_MODEL_V2']"],
    ['process.env?.MONEY_MODEL_V2'],
    ["process.env?.['MONEY_MODEL_V2']"],
    ['const { MONEY_MODEL_V2 } = process.env'],
    ['const { MONEY_MODEL_V2: flag = "false" } = process.env'],
    ['env.MONEY_MODEL_V2'],
    ['import.meta.env.MONEY_MODEL_V2'],
    ["envBool('MONEY_MODEL_V2', false)"],
    ['envBool("MONEY_MODEL_V2", false)'],
    ['envBool(`MONEY_MODEL_V2`, false)'],
    ["getFlag('MONEY_MODEL_V2')"],
    ['process.env.NEXT_PUBLIC_MONEY_MODEL_V2'],
    ['      MONEY_MODEL_V2: "true"'],
    ['ENV MONEY_MODEL_V2=true'],
    ['MONEY_MODEL_V2=true'],
    ['process.env.MONEY_MODEL_V2_ACTIVE'],
    ['const x = MONEY_MODEL_V2_ACTIVE;'],
    ["envBool('MONEY_MODEL_V2_ACTIVE', false)"],
    ['export const MONEY_MODEL_V2_ACTIVE = false;'],
    ['isMoneyModelV2Enabled()'],
    ['const LEGACY_INCLUDED_CREDIT_RATIO_BPS = 10_000;'],
  ])('D-OW-17 the pattern MUST match: %s', (line) => {
    expect(MONEY_MODEL_ENV_READ.test(line)).toBe(true);
  });

  it.each([
    ['const MONEY_MODEL_V2_ACTIVE_LABEL = 1;'],
    ['INCLUDED_CREDIT_RATIO_BPS.pro'],
    ['isMoneyModelV2'],
  ])('D-OW-17 the pattern must NOT match a longer or unrelated name: %s', (line) => {
    expect(MONEY_MODEL_ENV_READ.test(line)).toBe(false);
  });
});
