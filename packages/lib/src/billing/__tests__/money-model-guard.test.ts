import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, listSourceFiles } from '../../__tests__/seams/walk';
import { findConversionsInSource, isMoneyName } from '../../__tests__/seams/money-conversion-scan';

/**
 * MON-5 "A test greps for any second conversion and fails on it."
 *
 * The money model is defined ONCE in packages/lib/src/billing/money-model.ts. Every
 * other file converts through it (creditsFromCents, centsFromCredits, dollarsFromCents,
 * centsFromDollars, exactCentsFromDollars, chargedCentsFromProviderDollars,
 * providerDollarsCoveredByCents, formatCreditCount, CENTS_PER_DOLLAR in SQL). A literal
 * `100` multiplying or dividing a money value anywhere else is a second definition of
 * what a credit (or a dollar) is.
 *
 * The rule lives in __tests__/seams/money-conversion-scan.ts. Review 2 found the old
 * line regex could not be made to fail for a call result (M9b `walletRemainingCents(x) /
 * 100`) or a name without "cents"/"credit" (M9c `costDollars * 100`); the cases below
 * pin both, plus parenthesised chains, continuation lines, SQL interpolations, and the
 * percentages the rule must leave alone. There is no allowlist.
 */

/** The one file allowed to state the conversion. */
const MONEY_MODEL = 'packages/lib/src/billing/money-model.ts';

/** Every app and package, and the repo scripts (walk.ts skips tests, __tests__, builds). */
const ROOTS = ['apps', 'packages', 'scripts'] as const;

const flagged = (code: string) => findConversionsInSource(code).length > 0;

describe('MON-5 (partial) no second credit or cents conversion outside money-model.ts', () => {
  it('MON-5 (partial) the scanner sees the repo: money-model.ts and every app are scanned', () => {
    const files = listSourceFiles(ROOTS);
    expect(readFileSync(join(REPO_ROOT, MONEY_MODEL), 'utf8')).toContain('CREDITS_PER_DOLLAR');
    for (const app of ['web', 'admin', 'marketing', 'realtime', 'processor', 'control-plane']) {
      expect(files.some((f) => f.startsWith(`apps/${app}/src/`)), app).toBe(true);
    }
    expect(files.some((f) => f.startsWith('packages/cli/src/'))).toBe(true);
  });

  it.each([
    ['M9b: a call result divided by 100', 'const credits = walletRemainingCents(x) / 100;'],
    ['M9c: a dollars name times 100', 'const cents = costDollars * 100;'],
    ['a cents identifier', 'const dollars = cents / 100;'],
    ['a member path', 'realCost: +(r.realCostCents / 100).toFixed(2),'],
    ['a JSX expression', 'min={TOPUP_MIN_CENTS / 100}'],
    ['a credits name times 100', 'const units = credits * 100;'],
    ['the commutative multiply', 'const c = 100 * packCents;'],
    ['a Stripe amount', "new Intl.NumberFormat('en-US').format(amount / 100);"],
    ['a snake_case amount', 'discount = coupon.amount_off / 100;'],
    ['an object segment names the money', 'const originalPriceCents = plan.price.monthly * 100;'],
    ['round of a dollars name', 'const realCostCents = Math.max(0, Math.round(input.costDollars * 100));'],
    ['a nullish default inside a call', 'billedRealCostCents: Math.round((row.cost ?? 0) * 100),'],
    ['Number() of an optional chain', 'const spentCents = Math.floor(Number(agg[0]?.costUsd ?? 0) * 100);'],
    ['parseFloat of a Stripe decimal', 'Math.round(parseFloat(line.pricing.unit_amount_decimal) * 100)'],
    ['a chain through a markup factor', 'const charged = calculateVoiceCostDollars(model, q) * (MARKUP_BPS / 10_000) * 100;'],
    ['a divisor chain', 'const d = CREDIT_HOLD_ESTIMATE_CENTS / (MARKUP_BPS / 10000) / 100;'],
    ['a cents value divided back to dollars inside a call', 'chargeMillicents(Math.abs(deltaCents) / 100, markupBps)'],
    ['a SQL interpolation with a cast', 'sql`CASE WHEN ${aiUsageLogs.cost} IS NOT NULL THEN ${aiUsageLogs.cost}::numeric * 100 END`'],
    ['a SQL COALESCE of a cost column', 'sql`ROUND(SUM(COALESCE(${aiUsageLogs.cost}, 0) * 100))`'],
    ['a continuation line that starts with *', 'const cents = costDollars\n  * 100;'],
    ['a divide on the next line', 'const dollars = walletRemainingCents(x)\n  / 100;'],
  ])('MON-5 (partial) the rule flags %s', (_label, code) => {
    expect(flagged(code)).toBe(true);
  });

  it.each([
    ['a percent of allowance', 'return (cents / allowanceCents) * 100;'],
    ['a margin percentage', 'return ((chargedCents - realCostCents) / realCostCents) * 100;'],
    ['a bytes formatter', 'return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;'],
    ['a progress bar', 'const pct = Math.round((completed / total) * 100);'],
    ['a millicent scale', 'Math.round(millicents / 1000) * 100_000'],
    ['basis points', 'const bps = cents / 10000;'],
    ['a percent constant', 'const pct = LOW_BALANCE_THRESHOLD_PCT / 100;'],
    ['a coupon percent', 'Math.round(originalAmount * (1 - coupon.percent_off / 100))'],
    ['a line comment', '// cents / 100 in a comment is fine'],
    ['a block comment', '/**\n * costDollars * 100 is how it used to be done\n */\nconst x = 1;'],
    ['a low-balance threshold percent', 'netMonthly / monthly.allowance <= LOW_BALANCE_THRESHOLD_PCT / 100'],
    ['a string', "const s = 'cents / 100';"],
    ['markdown in a template', 'const md = `- **Business:** 100/month in credits`;'],
    ['a timer', 'setTimeout(flushSpend, 100);'],
    ['a longer literal', 'const x = costDollars * 1000;'],
  ])('MON-5 (partial) the rule ignores %s', (_label, code) => {
    expect(flagged(code)).toBe(false);
  });

  it('MON-5 (partial) money names are words, not substrings', () => {
    expect(isMoneyName('realCostCents')).toBe(true);
    expect(isMoneyName('unit_amount_decimal')).toBe(true);
    expect(isMoneyName('CREDIT_HOLD_ESTIMATE_CENTS')).toBe(true);
    expect(isMoneyName('costUsd')).toBe(true);
    expect(isMoneyName('usedBytes')).toBe(false);
    expect(isMoneyName('feedbackCount')).toBe(false);
    expect(isMoneyName('percent_off')).toBe(false);
  });

  it('MON-5 (partial) no file in any app, package, or script multiplies or divides a money value by 100', () => {
    const hits = listSourceFiles(ROOTS)
      .filter((f) => f !== MONEY_MODEL)
      .flatMap((f) =>
        findConversionsInSource(readFileSync(join(REPO_ROOT, f), 'utf8')).map((h) => `${f}:${h.line}: ${h.text}`),
      );
    expect(
      hits,
      `Second credit/cents conversion(s) found — route them through ${MONEY_MODEL}:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
