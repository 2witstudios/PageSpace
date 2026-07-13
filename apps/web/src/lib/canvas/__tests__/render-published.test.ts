import { describe, it, expect } from 'vitest';
import { renderPublishedPage, renderPublishedDocument, renderPublishedCode, renderPublishedSheet } from '../render-published';

describe('renderPublishedPage', () => {
  it('given any input, should return a full HTML document', () => {
    const out = renderPublishedPage({ html: '<p>hello</p>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('</html>');
    expect(out).toContain('<body>');
  });

  it('given an author <script>, should PRESERVE it (published policy)', () => {
    const out = renderPublishedPage({
      html: '<div id="app"></div><script>document.getElementById("app").textContent = "hi";</script>',
    });
    expect(out).toContain('<script>');
    expect(out).toContain('document.getElementById("app")');
  });

  it('given an external url() inside an author <style>, should sanitize it', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://evil.com/pixel.png"); }</style><p>x</p>',
    });
    expect(out).not.toContain('https://evil.com');
    expect(out).toContain('url("")');
  });

  it('given a data:image url() inside an author <style>, should preserve it', () => {
    const out = renderPublishedPage({
      html: '<style>.x { background: url("data:image/png;base64,iVBORw0KGgo="); }</style>',
    });
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('should embed the baseline CSP <meta>', () => {
    const out = renderPublishedPage({ html: '<p>x</p>' });
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("script-src 'unsafe-inline'");
  });

  it('should embed NO cookie, session, token, or API URL strings', () => {
    const out = renderPublishedPage({
      html: '<p>x</p>',
      title: 'My Page',
    });
    const lower = out.toLowerCase();
    expect(lower).not.toContain('cookie');
    expect(lower).not.toContain('session');
    expect(lower).not.toContain('token');
    expect(lower).not.toContain('authorization');
  });

  it('given a title with HTML, should escape it', () => {
    const out = renderPublishedPage({
      html: '<p>x</p>',
      title: '<script>alert(1)</script>',
    });
    expect(out).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(out).not.toContain('<title><script>');
  });

  it('given no title, should default to Untitled', () => {
    const out = renderPublishedPage({ html: '<p>x</p>' });
    expect(out).toContain('<title>Untitled</title>');
  });
});

describe('renderPublishedPage — assetBaseUrl', () => {
  it('given assetBaseUrl, should allow that host in CSS url() values', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://pagespace-published.t3.tigrisfiles.io/assets/abc123"); }</style>',
      assetBaseUrl: 'https://pagespace-published.t3.tigrisfiles.io',
    });
    expect(out).toContain('https://pagespace-published.t3.tigrisfiles.io/assets/abc123');
    expect(out).not.toContain('url("")');
  });

  it('given assetBaseUrl, should still block other HTTPS hosts in CSS url()', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://evil.com/tracker.gif"); }</style>',
      assetBaseUrl: 'https://pagespace-published.t3.tigrisfiles.io',
    });
    expect(out).not.toContain('evil.com');
    expect(out).toContain('url("")');
  });

  it('given no assetBaseUrl, should block all external HTTPS url() values (existing default)', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://pagespace-published.t3.tigrisfiles.io/assets/abc"); }</style>',
    });
    expect(out).not.toContain('pagespace-published.t3.tigrisfiles.io');
    expect(out).toContain('url("")');
  });

  it('given assetBaseUrl with trailing slash, should derive host correctly and allow it', () => {
    const out = renderPublishedPage({
      html: '<style>body { background: url("https://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'https://cdn.example.com/',
    });
    expect(out).toContain('https://cdn.example.com/assets/x');
  });

  it('given a non-HTTPS assetBaseUrl, should reject it instead of allowlisting the host', () => {
    expect(() => renderPublishedPage({
      html: '<style>body { background: url("http://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'http://cdn.example.com',
    })).toThrow(/HTTPS/i);
  });

  it('given an assetBaseUrl with credentials, should reject it instead of allowlisting the host', () => {
    expect(() => renderPublishedPage({
      html: '<style>body { background: url("https://cdn.example.com/assets/x"); }</style>',
      assetBaseUrl: 'https://user:pass@cdn.example.com',
    })).toThrow(/origin/i);
  });
});

describe('renderPublishedPage — SEO + social passthrough', () => {
  const pageUrl = 'https://acme.pagespace.site/my-page';

  it('given pageUrl, should emit canonical, robots (default index), and JSON-LD', () => {
    const out = renderPublishedPage({ html: '<p>About cats.</p>', title: 'Cats', pageUrl });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain(`<link rel="canonical" href="${pageUrl}">`);
    expect(head).toContain('<meta name="robots" content="index, follow">');
    expect(head).toContain('<script type="application/ld+json">');
  });

  it('given an explicit description, should emit it as the meta description', () => {
    const out = renderPublishedPage({ html: '<p>x</p>', pageUrl, description: 'Hand-written summary' });
    expect(out).toContain('<meta name="description" content="Hand-written summary">');
  });

  it('given robots="noindex", should emit a noindex robots directive', () => {
    const out = renderPublishedPage({ html: '<p>x</p>', pageUrl, robots: 'noindex' });
    expect(out).toContain('<meta name="robots" content="noindex">');
  });

  it('given ogImageUrl + ogDescription, should emit twitter card tags reusing them', () => {
    const out = renderPublishedPage({
      html: '<p>x</p>',
      pageUrl,
      ogImageUrl: 'https://pagespace.ai/og.png',
      ogDescription: 'Social blurb',
    });
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(out).toContain('<meta name="twitter:image" content="https://pagespace.ai/og.png">');
    expect(out).toContain('<meta name="twitter:description" content="Social blurb">');
  });

  it('given a lang, should set <html lang>', () => {
    const out = renderPublishedPage({ html: '<p>x</p>', pageUrl, lang: 'es' });
    expect(out).toContain('<html lang="es">');
  });

  it('given published page, should ALWAYS inject the theme bridge (for prefers-color-scheme support)', () => {
    const out = renderPublishedPage({ html: '<p>x</p>', pageUrl });
    expect(out).toContain('prefers-color-scheme');
    expect(out).toContain('pagespace-theme');
  });
});

describe('renderPublishedDocument', () => {
  it('given HTML content, should return a full document with typography and no theme bridge', () => {
    const out = renderPublishedDocument({ html: '<p>hello</p>', title: 'My Doc' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('ps-document');
    expect(out).toContain('<p>hello</p>');
    expect(out).not.toContain('pagespace-theme');
  });

  it('should apply the document CSP (script-src none)', () => {
    const out = renderPublishedDocument({ html: '<p>x</p>', title: 'Doc' });
    expect(out).toContain("script-src 'none'");
  });

  it('given a raw <script>, should strip it (documents never run author scripts)', () => {
    const out = renderPublishedDocument({
      html: '<p>x</p><script>alert(1)</script>',
      title: 'Doc',
    });
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('given a non-HTTPS assetBaseUrl, should reject it (same allowedAssetHosts plumbing as renderPublishedPage)', () => {
    expect(() => renderPublishedDocument({
      html: '<p>x</p>',
      title: 'Doc',
      assetBaseUrl: 'http://cdn.example.com',
    })).toThrow(/HTTPS/i);
  });

  it('given pageUrl, should emit SEO tags (same head assembly as canvas)', () => {
    const out = renderPublishedDocument({
      html: '<p>x</p>',
      title: 'Doc',
      pageUrl: 'https://acme.pagespace.site/doc',
    });
    expect(out).toContain('<link rel="canonical" href="https://acme.pagespace.site/doc">');
  });

  it('given no title, should default to Untitled', () => {
    const out = renderPublishedDocument({ html: '<p>x</p>' });
    expect(out).toContain('<title>Untitled</title>');
  });
});

describe('renderPublishedCode', () => {
  it('given a code string, should escape and wrap it in <pre><code>', () => {
    const out = renderPublishedCode({ code: '<script>alert(1)</script>', title: 'main.ts' });
    expect(out).toContain('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('should apply the document CSP (script-src none)', () => {
    const out = renderPublishedCode({ code: 'const x = 1;', title: 'main.ts' });
    expect(out).toContain("script-src 'none'");
  });

  it('given pageUrl, should emit SEO tags', () => {
    const out = renderPublishedCode({
      code: 'const x = 1;',
      title: 'main.ts',
      pageUrl: 'https://acme.pagespace.site/main-ts',
    });
    expect(out).toContain('<link rel="canonical" href="https://acme.pagespace.site/main-ts">');
  });

  it('given no title, should default to Untitled', () => {
    const out = renderPublishedCode({ code: 'const x = 1;' });
    expect(out).toContain('<title>Untitled</title>');
  });
});

describe('renderPublishedSheet', () => {
  it('given serialized sheet content, should render an HTML table', () => {
    const out = renderPublishedSheet({
      serializedContent: JSON.stringify({ cells: { A1: 'hi' } }),
      title: 'My Sheet',
    });
    expect(out).toContain('<table>');
    expect(out).toContain('hi');
  });

  it('given empty sheet content, should render the empty-state message', () => {
    const out = renderPublishedSheet({
      serializedContent: JSON.stringify({ cells: {} }),
      title: 'My Sheet',
    });
    expect(out).toContain('This sheet is empty.');
  });

  it('should apply the document CSP (script-src none)', () => {
    const out = renderPublishedSheet({ serializedContent: JSON.stringify({ cells: {} }), title: 'Sheet' });
    expect(out).toContain("script-src 'none'");
  });

  it('given no title, should default to Untitled', () => {
    const out = renderPublishedSheet({ serializedContent: JSON.stringify({ cells: {} }) });
    expect(out).toContain('<title>Untitled</title>');
  });
});
