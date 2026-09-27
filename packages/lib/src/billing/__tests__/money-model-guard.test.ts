import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, listSourceFiles } from '../../__tests__/seams/walk';
import {
  CREDIT_FIGURE,
  FOUNDER_PLAN,
  KNOWN_LIMITS,
  findConversionsInSource,
  findCopyHits,
  isMoneyName,
} from '../../__tests__/seams/money-conversion-scan';

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
    ['a compound multiply', 'costDollars *= 100;'],
    ['a compound divide on a cents name', 'totalCents /= 100;'],
    ['CENTS_PER_DOLLAR outside SQL', 'const dollars = cents / CENTS_PER_DOLLAR;'],
    ['CENTS_PER_DOLLAR as a factor', 'const cents = CENTS_PER_DOLLAR * price;'],
    ['100.0 as the literal', 'const d = amount / 100.0;'],
    ['1e2 as the literal', 'const d = amount / 1e2;'],
    ['0.01 as the factor', 'const d = amountCents * 0.01;'],
    ['a balance name', 'const d = wallet.balance / 100;'],
    ['a subtotal name', 'const d = invoice.subtotal / 100;'],
    ['a budget name', 'const d = monthlyBudget / 100;'],
    ['1e-2 as the factor', 'const d = cents * 1e-2;'],
    ['a renamed CENTS_PER_DOLLAR import', "import { CENTS_PER_DOLLAR as K } from '@pagespace/lib/billing/money-model';"],
    ['a hundred over a money value', 'const perCent = 100 / costCents;'],
    // Stripe totals: the field says no unit, the object does.
    ['a Stripe invoice total', 'const d = invoice.total / 100;'],
    ['an upcoming invoice total', "format(upcomingInvoice?.total / 100, 'usd');"],
    ['a Stripe invoice tax', 'const d = invoice.tax / 100;'],
    ['a charge amount', 'const d = charge.amount / 100;'],
    // Review 5330569519 P2-N1: shapes the P3-2 fix had let through.
    ['a difference with an unnamed term', 'const d = (amountPaid - refunded) / 100;'],
    ['a sum with an unnamed term', 'const c = Math.round((costDollars + overhead) * 100);'],
    ['a ternary with a literal branch', 'const c = (isTrial ? 0 : costDollars) * 100;'],
    ['a name with "share" mid-word', 'const d = revenueShareCents / 100;'],
    ['a per-seat share in cents', 'const d = perSeatShareCents / 100;'],
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
    ['a guarded percent of allowance', 'const pct = allowance > 0 ? (used / allowance) * 100 : 0;'],
    ['a growth percentage over an unnamed base', 'const growth = ((revenue - prev) / prev) * 100;'],
    ['a cost share', 'const pct = costShare * 100;'],
    ['a cost fraction', 'const pct = Math.round(costFraction * 100);'],
    ['CENTS_PER_DOLLAR interpolated into SQL', 'sql`SUM(${aiUsageLogs.cost} * ${CENTS_PER_DOLLAR})`'],
    ['CENTS_PER_DOLLAR imported', "import { CENTS_PER_DOLLAR, centsFromDollars } from '@pagespace/lib/billing/money-model';"],
    ['a 10% discount (0.1 is not a hundredth)', 'const off = priceCents * 0.1;'],
    ['a millicent scale (0.001 is not a hundredth)', 'const m = amountCents * 0.001;'],
    ['an invoice count', 'const pct = (overdue / invoice.count) * 100;'],
    ['an unrelated total', 'const pct = Math.round((completed / total) * 100);'],
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
    expect(isMoneyName('LOW_BALANCE_THRESHOLD_PCT')).toBe(false);
    expect(isMoneyName('costShare')).toBe(false);
  });

  it('MON-5 (partial) the scanner documents its known limits, each with a shape, an example and why', () => {
    expect(KNOWN_LIMITS.length).toBeGreaterThanOrEqual(7);
    for (const limit of KNOWN_LIMITS) {
      expect(limit.shape.length, limit.shape).toBeGreaterThan(0);
      expect(limit.why.length, limit.shape).toBeGreaterThan(0);
    }
    expect(KNOWN_LIMITS.map((l) => l.shape)).toEqual(
      expect.arrayContaining([
        'a destructured or aliased operand',
        'a value split across a variable',
        'a divisor spelled as a named constant',
      ]),
    );
  });

  it.each(KNOWN_LIMITS.map((l) => [l.shape, l.example]))('MON-5 (partial) KNOWN LIMIT, not caught: %s', (_shape, code) => {
    // The guard's real reach: each of these slips, on purpose written down. Closing one
    // turns this red — move its example into the "flags" table and drop it from KNOWN_LIMITS.
    expect(flagged(code)).toBe(false);
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

/**
 * MON-1 "No other file may state an allowance, a pack size, or a credit-to-money
 * conversion" and D-OW-18 (copy refers to the pricing page rather than stating numbers),
 * for the text people read: no literal credit figure in any app's source or the email
 * templates, and no mention of the removed Founder plan (A-9) in marketing or email copy.
 * Figures interpolated from the money model pass; comments are skipped.
 */
const COPY_ROOTS = ['apps', 'packages/lib/src/email-templates', 'packages/lib/emails'] as const;
const FOUNDER_COPY_ROOTS = ['apps/marketing', 'packages/lib/src/email-templates', 'packages/lib/emails'] as const;
const copyHits = (roots: readonly string[], pattern: RegExp) =>
  listSourceFiles(roots).flatMap((f) =>
    findCopyHits(readFileSync(join(REPO_ROOT, f), 'utf8'), pattern).map((h) => `${f}:${h.line}: ${h.text}`),
  );

describe('MON-1 (partial) no published copy states a credit figure or names the Founder plan', () => {
  it.each([
    ['- **Free:** 5 credits to start'],
    ['- **Pro:** 15/month in credits'],
    ['<li>1,000 credits for $10</li>'],
    ["const label = '900 credits a month';"],
    ['Start with 500 free credits'],
    ['Pro includes 1,500 AI credits a month'],
    ['Credits: 1500/month'],
    ['Pro: 1500 Credits'],
    ['1.5k credits'],
  ])('MON-1 (partial) the figure rule flags %s', (line) => {
    expect(findCopyHits(line, CREDIT_FIGURE)).toHaveLength(1);
  });

  it.each([
    ['<li>{MONTHLY_CREDITS.pro} credits a month</li>'],
    ['<h3>11.3 Credits and Usage Limits</h3>'],
    ['// 5 credits in a comment'],
    ['`${formatCreditCount(cents)} credits`'],
    ["wallet: { credits: 1_200, over: false },"],
  ])('MON-1 (partial) the figure rule ignores %s', (line) => {
    expect(findCopyHits(line, CREDIT_FIGURE)).toHaveLength(0);
  });

  it('MON-1 (partial) the Founder rule matches the word, not NotFoundError', () => {
    expect(findCopyHits('**Pro, Founder, and Business** unlock', FOUNDER_PLAN)).toHaveLength(1);
    expect(findCopyHits('the Founders plan', FOUNDER_PLAN)).toHaveLength(1);
    expect(findCopyHits('throw new SheetTabNotFoundError(id);', FOUNDER_PLAN)).toHaveLength(0);
  });

  it('MON-1 (partial) no app or email template states a literal credit figure', () => {
    const hits = copyHits(COPY_ROOTS, CREDIT_FIGURE);
    expect(hits, `Credit figure(s) in copy — derive them from money-model/credit-copy or link the pricing page:\n${hits.join('\n')}`).toEqual([]);
  });

  it('MON-1 (partial) no marketing page or email names the removed Founder plan', () => {
    const hits = copyHits(FOUNDER_COPY_ROOTS, FOUNDER_PLAN);
    expect(hits, `Founder plan named in copy (removed, A-9):\n${hits.join('\n')}`).toEqual([]);
  });
});
