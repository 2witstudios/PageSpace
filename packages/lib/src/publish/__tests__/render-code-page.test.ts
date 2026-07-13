import { describe, it, expect } from 'vitest';

import { renderCodePage } from '../render-code-page';
import { buildDocumentCsp } from '../../canvas/csp';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

describe('renderCodePage', () => {
  it('should emit the code inside a <pre><code> block', () => {
    assert({
      given: 'a plain code string',
      should: 'wrap it in <pre><code>',
      actual: renderCodePage({ code: 'const x = 1;', title: 'snippet.ts' }).includes(
        '<pre><code>const x = 1;</code></pre>',
      ),
      expected: true,
    });
  });

  it('should HTML-escape the code', () => {
    assert({
      given: 'code containing HTML-special characters',
      should: 'escape them so they render as text, not markup',
      actual: renderCodePage({ code: '<script>alert(1)</script> & "x" \'y\'', title: 'T' }).includes(
        '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;</code></pre>',
      ),
      expected: true,
    });
  });

  it('should render an empty <pre><code> for empty code', () => {
    assert({
      given: 'an empty code string',
      should: 'still emit a (empty) <pre><code> block, not throw',
      actual: renderCodePage({ code: '', title: 'T' }).includes('<pre><code></code></pre>'),
      expected: true,
    });
  });

  it('should wrap the code inside the shared .ps-document shell with a title header', () => {
    const html = renderCodePage({ code: 'x', title: 'My Snippet' });
    assert({
      given: 'a code page render',
      should: 'emit <article class="ps-document"> with a <header><h1> title around the code block',
      actual: html.includes(
        '<article class="ps-document"><header><h1>My Snippet</h1></header><pre><code>x</code></pre></article>',
      ),
      expected: true,
    });
  });

  it('should delegate head assembly to renderCanvasDocument (doctype, title, typography CSS)', () => {
    const html = renderCodePage({ code: 'x', title: 'My Snippet' });
    assert({
      given: 'a code page render',
      should: 'produce a full standalone document with the title and inlined document typography CSS',
      actual:
        html.startsWith('<!doctype html>') &&
        html.includes('</html>') &&
        html.includes('<title>My Snippet</title>') &&
        html.includes('.ps-document {') &&
        html.includes('max-width: 42rem'),
      expected: true,
    });
  });

  it('should carry buildDocumentCsp() (script-src none) as the CSP override', () => {
    const html = renderCodePage({ code: 'x', title: 'T' });
    assert({
      given: 'a rendered code page',
      should: "carry buildDocumentCsp()'s content verbatim in the CSP meta tag",
      actual: html.includes(`content="${buildDocumentCsp()}"`) && html.includes("script-src 'none'"),
      expected: true,
    });
  });

  it('should omit the theme-bridge script', () => {
    assert({
      given: 'a rendered code page (standalone, not an in-app iframe)',
      should: 'not inject the theme-bridge <script>',
      actual: renderCodePage({ code: 'x', title: 'T' }).includes('pagespace-theme'),
      expected: false,
    });
  });

  it('should never emit a <script> tag, no matter the code content', () => {
    const html = renderCodePage({
      code: '</code></pre></article></body></html><script>alert(1)</script>',
      title: 'T',
    });
    assert({
      given: 'code that attempts to break out of <pre><code> and inject a script tag',
      should: 'contain no literal <script tag anywhere in the output',
      actual: /<script/i.test(html),
      expected: false,
    });
  });

  it('should respect an explicit lang override', () => {
    assert({
      given: 'an explicit lang',
      should: 'set <html lang>',
      actual: renderCodePage({ code: 'x', title: 'T', lang: 'fr' }).includes('<html lang="fr">'),
      expected: true,
    });
  });

  it('should emit the canonical link and OG tags when pageUrl is provided', () => {
    const html = renderCodePage({
      code: 'x',
      title: 'My Snippet',
      pageUrl: 'https://acme.pagespace.site/snippet',
      ogImageUrl: 'https://acme.pagespace.site/og.png',
      ogDescription: 'A great snippet',
    });
    assert({
      given: 'pageUrl, ogImageUrl and ogDescription',
      should: 'emit a canonical link and OG meta tags (passed through to renderCanvasDocument)',
      actual:
        html.includes('<link rel="canonical" href="https://acme.pagespace.site/snippet">') &&
        html.includes('<meta property="og:image" content="https://acme.pagespace.site/og.png">') &&
        html.includes('<meta property="og:description" content="A great snippet">'),
      expected: true,
    });
  });

  it('should omit the canonical link and OG tags when pageUrl is absent', () => {
    const html = renderCodePage({ code: 'x', title: 'T' });
    assert({
      given: 'no pageUrl',
      should: 'omit canonical/OG tags entirely',
      actual: html.includes('rel="canonical"') || html.includes('property="og:'),
      expected: false,
    });
  });
});
