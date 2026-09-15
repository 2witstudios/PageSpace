import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * MON-5 "A test greps for any second conversion and fails on it."
 *
 * The money model is defined ONCE in packages/lib/src/billing/money-model.ts. Every
 * other file converts through it (creditsFromCents, centsFromCredits,
 * dollarsFromCents, formatCreditCount). A literal `/ 100` or `* 100` applied to a
 * cents or credit value anywhere else is a second definition of what a credit (or a
 * dollar) is, and it is exactly how "15 credits" drifted from "1500 cents" before.
 *
 * Rule: a source line is a violation when it multiplies or divides by the literal
 * 100 and the operand adjacent to that operator is an identifier (or member path)
 * whose name mentions cents or credit(s), e.g. `cents / 100`, `r.realCostCents / 100`,
 * `100 * TOPUP_MIN_CENTS`. Percent maths on unrelated names, `* 100_000`, and
 * `/ 10000` (basis points) do not match. Comments are skipped.
 */

const ROOTS = [
  'packages/lib/src',
  'apps/web/src',
  'apps/marketing/src',
  'apps/admin/src',
  'packages/cli/src',
];

/** The one file allowed to state the conversion. */
const ALLOWED = new Set(['packages/lib/src/billing/money-model.ts']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '__tests__', '__fixtures__', 'coverage']);
const SOURCE_EXT = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const MONEY_NAME = /cents|credit/i;
// `<ident> / 100` or `<ident> * 100`, where 100 is the whole literal (not 1000, 100_000, 100.5).
const LEFT = new RegExp(String.raw`(${IDENT})\s*[/*]\s*100(?![\d_.])`, 'g');
// `100 * <ident>` (the commutative multiply).
const RIGHT = new RegExp(String.raw`(?<![\d_.])100\s*\*\s*(${IDENT})`, 'g');

function lastSegment(ident: string): string {
  const parts = ident.split('.');
  return parts[parts.length - 1] ?? ident;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

export function findSecondConversions(repoRoot: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXT.test(name) || TEST_FILE.test(name)) continue;
      const rel = relative(repoRoot, full).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        const names: string[] = [];
        for (const m of line.matchAll(LEFT)) names.push(m[1]);
        for (const m of line.matchAll(RIGHT)) names.push(m[1]);
        if (names.some((n) => MONEY_NAME.test(lastSegment(n)))) {
          hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  };
  for (const root of ROOTS) {
    const abs = join(repoRoot, root);
    try {
      statSync(abs);
    } catch {
      continue; // a root missing from a partial checkout is not a violation
    }
    walk(abs);
  }
  return hits;
}

describe('MON-5 no second credit or cents conversion outside money-model.ts', () => {
  const repoRoot = resolve(__dirname, '../../../../..');

  it('MON-5 the scanner sees the repo (money-model.ts exists at the allowed path)', () => {
    expect(() => statSync(join(repoRoot, 'packages/lib/src/billing/money-model.ts'))).not.toThrow();
  });

  it('MON-5 the rule itself catches the shapes it is meant to catch and ignores the rest', () => {
    const flagged = (line: string) => {
      const names: string[] = [];
      for (const m of line.matchAll(LEFT)) names.push(m[1]);
      for (const m of line.matchAll(RIGHT)) names.push(m[1]);
      return names.some((n) => MONEY_NAME.test(lastSegment(n)));
    };
    expect(flagged('const dollars = cents / 100;')).toBe(true);
    expect(flagged('realCost: +(r.realCostCents / 100).toFixed(2),')).toBe(true);
    expect(flagged('min={TOPUP_MIN_CENTS / 100}')).toBe(true);
    expect(flagged('const units = credits * 100;')).toBe(true);
    expect(flagged('const c = 100 * packCents;')).toBe(true);
    expect(flagged('return (cents / allowanceCents) * 100;')).toBe(false); // percent of allowance
    expect(flagged('Math.round(millicents / 1000) * 100_000')).toBe(false);
    expect(flagged('const bps = cents / 10000;')).toBe(false);
    expect(flagged('const pct = LOW_BALANCE_THRESHOLD_PCT / 100;')).toBe(false);
    expect(flagged('// cents / 100 in a comment is fine')).toBe(true); // comments are skipped by the walker, not the regex
  });

  it('MON-5 no file in lib, web, marketing, admin, or cli divides or multiplies a cents/credit value by 100', () => {
    const hits = findSecondConversions(repoRoot);
    expect(
      hits,
      `Second credit/cents conversion(s) found — route them through packages/lib/src/billing/money-model.ts:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
