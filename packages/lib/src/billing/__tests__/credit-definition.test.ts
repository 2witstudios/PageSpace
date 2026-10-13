import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, listSourceFiles } from '../../__tests__/seams/walk';
import { findConversionsInSource, maskSource } from '../../__tests__/seams/money-conversion-scan';
import { CREDITS_PER_DOLLAR, CENTS_PER_DOLLAR, centsFromCredits, creditsFromCents, formatCreditCount } from '../money-model';

/**
 * MON-5 in full: "One definition of a credit, one source of truth: a credit is
 * CREDITS_PER_DOLLAR⁻¹ of a dollar of credit value, defined once in the money-model module and
 * consumed by the lib formatter, the web formatter, the marketing mirror, admin, and the CLI.
 * formatCreditCount renders an integer count with thousands separators. toDisplayCredits and
 * formatCreditUnits are removed with their callers. A test greps for any second conversion and
 * fails on it." Each clause is one test below; the grep is money-conversion-scan, whose
 * remaining blind spots (a helper's parameter fed from another file, SQL in a quoted string, an
 * index path) are listed in its KNOWN_LIMITS and asserted in money-model-guard.test.ts.
 */
const MONEY_MODEL = 'packages/lib/src/billing/money-model.ts';
const ROOTS = ['apps', 'packages', 'scripts'] as const;
const read = (f: string) => readFileSync(join(REPO_ROOT, f), 'utf8');
const code = (f: string) => maskSource(read(f));
const sources = listSourceFiles(ROOTS);

describe('MON-5 a credit is defined once and consumed everywhere', () => {
  it('a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar: 100 credits to the dollar, converted exactly both ways', () => {
    expect(CREDITS_PER_DOLLAR).toBe(100);
    expect(creditsFromCents(CENTS_PER_DOLLAR)).toBe(CREDITS_PER_DOLLAR);
    expect(centsFromCredits(CREDITS_PER_DOLLAR)).toBe(CENTS_PER_DOLLAR);
    for (const cents of [0, 7, 99, 150_000]) expect(centsFromCredits(creditsFromCents(cents))).toBe(cents);
  });

  it('the rate and every conversion helper are declared in money-model.ts and nowhere else', () => {
    const DEFINES = /\b(?:const|let|var|function)\s+(CREDITS_PER_DOLLAR|CENTS_PER_DOLLAR|creditsFromCents|centsFromCredits|formatCreditCount|creditsFromDollars)\b/g;
    const elsewhere = sources
      .filter((f) => f !== MONEY_MODEL)
      .flatMap((f) => [...code(f).matchAll(DEFINES)].map((m) => `${f}: ${m[1]}`));
    expect(elsewhere).toEqual([]);
    expect([...code(MONEY_MODEL).matchAll(DEFINES)].map((m) => m[1]).sort()).toEqual(
      ['CENTS_PER_DOLLAR', 'CREDITS_PER_DOLLAR', 'centsFromCredits', 'creditsFromCents', 'creditsFromDollars', 'formatCreditCount'],
    );
  });

  it('formatCreditCount renders an integer count with thousands separators — never a decimal, never a dollar sign', () => {
    expect(formatCreditCount(1_500)).toBe('1,500');
    expect(formatCreditCount(900)).toBe('900');
    expect(formatCreditCount(12_345_678)).toBe('12,345,678');
    expect(formatCreditCount(1_234.6)).toBe('1,235');
    expect(formatCreditCount(-120)).toBe('-120');
    expect(formatCreditCount(-0.2)).toBe('0');
    for (const cents of [0, 1, 99, 1_234.5, 9_999_999]) {
      expect(formatCreditCount(cents)).toMatch(/^-?\d{1,3}(,\d{3})*$/);
    }
  });

  it('the lib formatter (credit-copy) formats through money-model and converts nothing itself', () => {
    const copy = read('packages/lib/src/billing/credit-copy.ts');
    expect(copy).toMatch(/import\s*\{[^}]*\bformatCreditCount\b[^}]*\}\s*from\s*'\.\/money-model'/);
    expect(findConversionsInSource(copy)).toEqual([]);
  });

  it('the web formatter and the marketing mirror only re-export money-model and credit-copy', () => {
    for (const f of ['apps/web/src/lib/subscription/credits.ts', 'apps/marketing/src/lib/credits.ts']) {
      const src = code(f);
      const reexports = [...read(f).matchAll(/export\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g)].map((m) => m[1]);
      expect(reexports.length, f).toBeGreaterThan(0);
      for (const from of reexports) expect(from, f).toMatch(/^@pagespace\/lib\/billing\/(money-model|credit-copy)$/);
      // No number of its own: no digit outside strings and comments, so no rate and no conversion.
      expect(src.replace(/["'`][^"'`\n]*["'`]/g, ''), f).not.toMatch(/(?<![\w$])\d/);
    }
    expect(read('apps/web/src/lib/subscription/credits.ts')).toMatch(/\bformatCreditCount\b[\s\S]*from\s*'@pagespace\/lib\/billing\/money-model'/);
  });

  it('admin renders credit counts with money-model formatCreditCount', () => {
    const adminFiles = sources.filter((f) => f.startsWith('apps/admin/src/'));
    const users = adminFiles.filter((f) => /\bformatCreditCount\b/.test(code(f)));
    expect(users.length).toBeGreaterThan(0);
    for (const f of users) {
      expect(read(f), f).toMatch(/import\s*\{[^}]*\bformatCreditCount\b[^}]*\}\s*from\s*["']@pagespace\/lib\/billing\/money-model["']/);
    }
  });

  it('the CLI prints the server-rendered count untouched: it imports no money model and labels only *Credits strings', () => {
    const cli = sources.filter((f) => f.startsWith('packages/cli/src/'));
    expect(cli.length).toBeGreaterThan(0);
    for (const f of cli) {
      expect(code(f), f).not.toMatch(/billing\/(money-model|credit-copy)/);
      expect(findConversionsInSource(read(f)), f).toEqual([]);
    }
    const wallets = code('packages/cli/src/commands/wallets.ts');
    const labelled = [...wallets.matchAll(/creditsLabel\(([^()]*)\)/g)].map((m) => m[1].trim()).filter((arg) => arg !== 'count: string');
    expect(labelled.length).toBeGreaterThan(0);
    for (const arg of labelled) expect(arg).toMatch(/Credits$/);
  });

  it('toDisplayCredits and formatCreditUnits are gone, with their callers', () => {
    const hits = sources.filter((f) => /\b(?:toDisplayCredits|formatCreditUnits)\b/.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('the grep for a second conversion finds none in any app, package or script', () => {
    const hits = sources
      .filter((f) => f !== MONEY_MODEL)
      .flatMap((f) => findConversionsInSource(read(f)).map((h) => `${f}:${h.line}: ${h.text}`));
    expect(hits).toEqual([]);
  });
});
