/**
 * UI-12 (Organizations & Wallets Spec): "the FAQ and pricing page source figures from the
 * module". Two halves, both needed:
 *   - the RENDERED page shows exactly the money-model module's figures, and
 *   - the page SOURCE states no credit figure of its own. A literal that happens to equal
 *     today's module value renders identically, so only the source scan catches it; it would
 *     silently go stale the day the ratio constant flips (D-OW-17).
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MONTHLY_CREDITS,
  FREE_STARTER_CREDITS_DISPLAY,
  creditPacksPhrase,
  creditsPhrase,
  includedCreditsPhrase,
  topUpRatePhrase,
} from '@pagespace/lib/billing/credit-copy';
import { TIERS } from '@pagespace/lib/billing/subscription-tiers';

// Site chrome (search, theme, auth buttons) is irrelevant to credit copy and needs a browser.
vi.mock('@/components/SiteNavbar', () => ({ SiteNavbar: () => null }));
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }));

/** Rendered markup as the visible text a reader sees: tags and React text separators removed. */
const visibleText = (html: string) =>
  html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/**
 * A credit figure stated as a literal in page source: "1,500 credits", "1500 credits", a figure
 * wrapped onto the next line before "credits" (JSX collapses the newline, so it renders the same),
 * a quoted or braced figure (`{"1,500"} credits`, `${"500"} credits`), or one word between
 * ("1,500 AI credits"). A module reference such as `{MONTHLY_CREDITS.pro} credits` has no digit
 * before the brace and does not match.
 */
const HARDCODED_CREDIT_FIGURE = /\d[\d,]*["'`}]{0,2}\s+(?:[A-Za-z]+\s+)?credits\b/;

const source = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

// No Spec ID in this title on purpose: it proves the scan, not the requirement.
describe('hardcoded-credit-figure source scan self-test', () => {
  // Every shape review 5230424182 planted in faq/page.tsx, plus the plain forms. Each renders the
  // same text as the module reference it replaces, so only this scan can catch it.
  it.each([
    ['same line', '1,500 credits a month'],
    ['no thousands separator', '1500 credits a month'],
    ['JSX text wrapped before "credits"', 'allowance — 1,500\n        credits a\n        month'],
    ['JSX expression holding a quoted literal', '{"1,500"} credits a month'],
    ['template literal holding a quoted literal', 'and ${"500"} credits to get started'],
    ['a bare number in braces', '{1500} credits'],
    ['one word between', '1,500 AI credits'],
  ])('catches a hardcoded figure: %s', (_shape, text) => {
    expect(text).toMatch(HARDCODED_CREDIT_FIGURE);
  });

  it.each([
    ['a JSX module reference', '{MONTHLY_CREDITS.pro} credits a\n        month'],
    ['a template module reference', '${FREE_STARTER_CREDITS_DISPLAY} credits to get started'],
    ['a phrase function', 'top-up packs come in ${creditPacksPhrase()}'],
    ['storage, not credits', 'includes 500 MB of storage'],
  ])('does not flag module-sourced copy: %s', (_shape, text) => {
    expect(text).not.toMatch(HARDCODED_CREDIT_FIGURE);
  });
});

describe('UI-12 credit figures on public pages come from the money-model module', () => {
  it('UI-12 the FAQ sources credit figures from the money-model module', async () => {
    const { default: FAQPage } = await import('../faq/page');
    const text = visibleText(renderToStaticMarkup(<FAQPage />));

    expect(text).toContain(`${FREE_STARTER_CREDITS_DISPLAY} credits to get started`);
    expect(text).toContain(`Free accounts start with ${FREE_STARTER_CREDITS_DISPLAY} credits, once`);
    expect(text).toContain(`${MONTHLY_CREDITS.pro} credits a month on Pro`);
    expect(text).toContain(`${MONTHLY_CREDITS.business} credits a month on Business`);
    expect(text).toContain(`top-up packs come in ${creditPacksPhrase()}`);

    expect(source('faq/page.tsx')).not.toMatch(HARDCODED_CREDIT_FIGURE);
  });

  it('UI-12 the pricing page sources credit figures from the money-model module', async () => {
    const { default: PricingPage } = await import('../pricing/page');
    const text = visibleText(renderToStaticMarkup(<PricingPage />));

    for (const tier of TIERS) {
      expect(text, tier).toContain(includedCreditsPhrase(tier));
      expect(text, tier).toContain(creditsPhrase(tier));
    }
    expect(text).toContain(topUpRatePhrase());

    expect(source('pricing/page.tsx')).not.toMatch(HARDCODED_CREDIT_FIGURE);
  });
});

describe('plan and seat prices on the FAQ and Terms come from the tier table', () => {
  /** A dollar figure typed into page source ("$15/month", "$10 per extra seat"); `${…}` does not match. */
  const HARDCODED_PRICE = /\$\d/;

  it('SEAT-2 (partial) the FAQ and Terms state the Pro price and the Business org terms from planFacts', async () => {
    const { planFacts } = await import('@pagespace/lib/billing/credit-copy');
    const { formatDollars } = await import('@pagespace/lib/billing/money-model');
    const pro = planFacts('pro');
    const business = planFacts('business');
    const org = business.org;
    if (!org) throw new Error('Business must be the org plan');
    const seatPrice = formatDollars(org.extraSeatPriceCents);

    const { default: FAQPage } = await import('../faq/page');
    const faq = visibleText(renderToStaticMarkup(<FAQPage />));
    expect(faq).toContain(`on Pro (${pro.price}/month)`);
    expect(faq).toContain(`on Business (${business.price}/month, the plan for an organization with ${org.includedSeats} seats included and ${seatPrice} per extra seat)`);

    const { default: TermsPage } = await import('../terms/page');
    const terms = visibleText(renderToStaticMarkup(<TermsPage />));
    expect(terms).toContain(`Pro Plan (${pro.price}/month):`);
    expect(terms).toContain(`Business Plan (${business.price}/month per organization, ${org.includedSeats} seats included, ${seatPrice} per extra seat):`);

    expect(source('faq/page.tsx')).not.toMatch(HARDCODED_PRICE);
    expect(source('terms/page.tsx')).not.toMatch(HARDCODED_PRICE);
  });
});
