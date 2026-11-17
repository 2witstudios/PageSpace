/**
 * The iOS app opens the legal pages with `?embed=1` (apps/web MarketingLink). Embedded, each
 * page is the same text without the site navigation and footer, and nothing on it links to
 * pricing or out of the embedded set — App Store Guideline 3.1.1 (no route to web prices).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A fixed web-app origin (the production default), set before any document or metadata.ts is evaluated: the report
// link assertions, and the pagespace.ai match in sameSiteHrefs, must not depend on the runner's NEXT_PUBLIC_APP_URL.
const { previousAppUrl } = vi.hoisted(() => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = 'https://pagespace.ai';
  return { previousAppUrl: previous };
});
afterAll(() => {
  if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
});
import { isEmbedded, isEmbeddedSearch, legalHref } from '@/lib/legal-embed';

vi.mock('@/components/SiteNavbar', () => ({ SiteNavbar: () => <nav data-testid="site-navbar" /> }));
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => <footer data-testid="site-footer" /> }));

const DOCUMENTS = [
  ['terms', async () => (await import('../terms/TermsDocument')).TermsDocument],
  ['privacy', async () => (await import('../privacy/PrivacyDocument')).PrivacyDocument],
  ['cookies', async () => (await import('../cookies/CookiesDocument')).CookiesDocument],
  ['subprocessors', async () => (await import('../subprocessors/SubprocessorsDocument')).SubprocessorsDocument],
] as const;

// Relative hrefs, plus absolute ones back to PageSpace (pagespace.ai or any subdomain), which
// would leave the embedded set just as surely — e.g. a /s/ share link into the dashboard.
const sameSiteHrefs = (html: string) =>
  [...html.matchAll(/href="((?:\/(?!\/)|(?:https?:)?\/\/(?:[\w-]+\.)*pagespace\.ai(?=[\/?#"]))[^"]*)"/g)].map((m) => m[1]);

describe('legal pages embedded in the iOS app', () => {
  it.each(DOCUMENTS)('given the web, the %s page keeps the site navigation and footer', async (_, load) => {
    const Document = await load();
    const html = renderToStaticMarkup(<Document embed={false} />);
    expect(html).toContain('data-testid="site-navbar"');
    expect(html).toContain('data-testid="site-footer"');
  });

  it.each(DOCUMENTS)('given embed, the %s page drops the navigation and footer and keeps every legal link embedded', async (_, load) => {
    const Document = await load();
    const html = renderToStaticMarkup(<Document embed />);
    expect(html).not.toContain('data-testid="site-navbar"');
    expect(html).not.toContain('data-testid="site-footer"');
    for (const href of sameSiteHrefs(html.replace(/&amp;/g, '&'))) {
      expect(href).toMatch(/^\/(privacy|terms|cookies|subprocessors)\?embed=1$/);
    }
  });

  it('given embed, the Terms name the pricing page without linking to it', async () => {
    const { TermsDocument } = await import('../terms/TermsDocument');
    const html = renderToStaticMarkup(<TermsDocument embed />);
    expect(html).not.toContain('href="/pricing"');
    expect(html).toContain('pricing page');
  });

  it('the Terms link the public report page on the web, and name it without a link when embedded', async () => {
    const { TermsDocument } = await import('../terms/TermsDocument');
    const web = renderToStaticMarkup(<TermsDocument embed={false} />);
    expect(web).toMatch(/href="https:\/\/pagespace\.ai\/report"/);
    expect(web).toContain('CyberTipline');
    const embedded = renderToStaticMarkup(<TermsDocument embed />);
    expect(embedded).not.toContain('/report"');
    expect(embedded).toContain('pagespace.ai/report');
  });

  it('the Terms and Privacy Policy cover purchases made through Apple', async () => {
    const { TermsDocument } = await import('../terms/TermsDocument');
    const { PrivacyDocument } = await import('../privacy/PrivacyDocument');
    expect(renderToStaticMarkup(<TermsDocument embed={false} />)).toContain('App Store account settings');
    expect(renderToStaticMarkup(<PrivacyDocument embed={false} />)).toContain('Apple In-App Purchase');
  });
});

describe('legal-embed helpers', () => {
  it('flags pagespace.ai absolute links as same-site', () => {
    expect(sameSiteHrefs('<a href="https://pagespace.ai/s/x"></a><a href="//www.pagespace.ai"></a><a href="/terms"></a>'))
      .toEqual(['https://pagespace.ai/s/x', '//www.pagespace.ai', '/terms']);
    expect(sameSiteHrefs('<a href="https://stripe.com/privacy"></a><a href="https://pagespace.ai.evil.com"></a>')).toEqual([]);
  });

  it('reads only embed=1 from a location search string', () => {
    expect(isEmbeddedSearch('?embed=1')).toBe(true);
    expect(isEmbeddedSearch('?foo=bar&embed=1')).toBe(true);
    expect(isEmbeddedSearch('?embed=0')).toBe(false);
    expect(isEmbeddedSearch('')).toBe(false);
  });

  it('reads only embed=1 as embedded', async () => {
    expect(await isEmbedded(Promise.resolve({ embed: '1' }))).toBe(true);
    expect(await isEmbedded(Promise.resolve({ embed: 'true' }))).toBe(false);
    expect(await isEmbedded(Promise.resolve({}))).toBe(false);
  });

  it('keeps the flag on links between legal pages only when embedded', () => {
    expect(legalHref('/privacy', true)).toBe('/privacy?embed=1');
    expect(legalHref('/privacy', false)).toBe('/privacy');
  });
});
