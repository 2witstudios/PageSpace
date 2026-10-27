import { describe, it, expect } from 'vitest';
import { renderDocumentPage } from '../render-document-page';

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

describe('renderDocumentPage', () => {
  it('should return a full standalone HTML document', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'a bare document body and title',
      should: 'wrap it in a full <!doctype html> document',
      actual: out.startsWith('<!doctype html>') && out.includes('</html>'),
      expected: true,
    });
  });

  it('should lock scripts down with script-src none', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'a rendered document page',
      should: "embed a CSP with script-src 'none'",
      actual: out.includes("script-src 'none'"),
      expected: true,
    });
  });

  it('should strip author <script> tags entirely (sanitizer + CSP belt-and-suspenders)', () => {
    const out = renderDocumentPage({
      html: '<p>hello</p><script>alert(1)</script>',
      title: 'My Doc',
    });
    assert({
      given: 'author HTML containing a <script> tag',
      should: 'contain no <script> remnants in the output',
      actual: out.includes('<script') || out.includes('alert(1)'),
      expected: false,
    });
  });

  it('should omit the theme-bridge script', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'a rendered document page (standalone, not an in-app iframe)',
      should: 'not inject the theme-bridge <script>',
      actual: out.includes('pagespace-theme'),
      expected: false,
    });
  });

  it('should wrap the body in a .ps-document article with a title header', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'a body with no leading <h1>',
      should: 'emit <article class="ps-document"> with a <header><h1> title',
      actual: out.includes('<article class="ps-document"><header><h1>My Doc</h1></header><p>hello</p></article>'),
      expected: true,
    });
  });

  it('should inline the document typography CSS', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'a rendered document page',
      should: 'inline the shared document typography rules into <head>',
      actual: out.includes('.ps-document {') && out.includes('max-width: 42rem'),
      expected: true,
    });
  });

  it('should emit the canonical link and OG tags when pageUrl is provided', () => {
    const out = renderDocumentPage({
      html: '<p>hello</p>',
      title: 'My Doc',
      pageUrl: 'https://acme.pagespace.site/my-doc',
      ogImageUrl: 'https://acme.pagespace.site/og.png',
      ogDescription: 'A great doc',
    });
    assert({
      given: 'pageUrl, ogImageUrl and ogDescription',
      should: 'emit a canonical link and OG meta tags',
      actual:
        out.includes('<link rel="canonical" href="https://acme.pagespace.site/my-doc">') &&
        out.includes('<meta property="og:image" content="https://acme.pagespace.site/og.png">') &&
        out.includes('<meta property="og:description" content="A great doc">'),
      expected: true,
    });
  });

  it('should omit the canonical link and OG tags when pageUrl is absent', () => {
    const out = renderDocumentPage({ html: '<p>hello</p>', title: 'My Doc' });
    assert({
      given: 'no pageUrl',
      should: 'omit canonical/OG tags entirely',
      actual: out.includes('rel="canonical"') || out.includes('property="og:'),
      expected: false,
    });
  });

  it('should sanitize dangerous attributes and iframes from the author body', () => {
    const out = renderDocumentPage({
      html: '<p onclick="evil()">hi</p><iframe src="https://evil.example"></iframe>',
      title: 'My Doc',
    });
    assert({
      given: 'author HTML with an event handler and an <iframe>',
      should: 'strip both before rendering',
      actual: out.includes('onclick') || out.includes('<iframe'),
      expected: false,
    });
  });

  it('should HTML-escape the title in both <title> and the header', () => {
    const out = renderDocumentPage({ html: '<p>x</p>', title: 'Fish & Chips' });
    assert({
      given: 'a title with an HTML-special character',
      should: 'escape it everywhere the title is emitted',
      actual: out.includes('Fish &amp; Chips') && !out.includes('Fish & Chips'),
      expected: true,
    });
  });
});
