import { describe, it, expect } from 'vitest';

import { renderCodePage } from '../render-code-page';
import { buildDocumentCsp } from '../document-shell';

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

  it('should delegate head assembly to the document shell', () => {
    const html = renderCodePage({ code: 'x', title: 'My Snippet' });
    assert({
      given: 'a code page render',
      should: 'produce a full standalone document with the title, the document typography shell, and the escaped code inside .ps-document',
      actual:
        html.startsWith('<!doctype html>') &&
        html.includes('<title>My Snippet</title>') &&
        html.includes('<article class="ps-document">') &&
        /<article class="ps-document">.*<pre><code>x<\/code><\/pre>.*<\/article>/.test(html),
      expected: true,
    });
  });

  it('should wrap the title as an <h1> header', () => {
    assert({
      given: 'a title',
      should: 'emit it as the document <h1> header',
      actual: renderCodePage({ code: 'x', title: 'My Snippet' }).includes(
        '<header><h1>My Snippet</h1></header>',
      ),
      expected: true,
    });
  });

  it('should carry the document CSP with script-src none', () => {
    const html = renderCodePage({ code: 'x', title: 'T' });
    assert({
      given: 'a rendered code page',
      should: "carry buildDocumentCsp()'s content in a CSP meta tag",
      actual: html.includes(`<meta http-equiv="Content-Security-Policy" content="${buildDocumentCsp()}">`),
      expected: true,
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
});
