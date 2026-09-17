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
