import { describe, it, expect } from 'vitest';

import {
  DOCUMENT_TYPOGRAPHY_CSS,
  documentStartsWithH1,
  wrapDocumentBody,
} from '../document-shell';

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

describe('DOCUMENT_TYPOGRAPHY_CSS', () => {
  it('should lay out a readable centered column', () => {
    assert({
      given: 'the typography CSS',
      should: 'constrain the column to 42rem, center it, and set body padding + line-height',
      actual:
        DOCUMENT_TYPOGRAPHY_CSS.includes('max-width: 42rem') &&
        DOCUMENT_TYPOGRAPHY_CSS.includes('margin: 0 auto') &&
        DOCUMENT_TYPOGRAPHY_CSS.includes('padding: 2rem 1rem') &&
        DOCUMENT_TYPOGRAPHY_CSS.includes('line-height: 1.65'),
      expected: true,
    });
  });

  it('should use a system font stack', () => {
    assert({
      given: 'the typography CSS',
      should: 'declare a system font stack (no webfont dependency)',
      actual: DOCUMENT_TYPOGRAPHY_CSS.includes('-apple-system'),
      expected: true,
    });
  });

  it('should include a dark-mode media query', () => {
    assert({
      given: 'the typography CSS',
      should: 'override colors under prefers-color-scheme: dark',
      actual: DOCUMENT_TYPOGRAPHY_CSS.includes('@media (prefers-color-scheme: dark)'),
      expected: true,
    });
  });

  it('should not reference app CSS variables', () => {
    assert({
      given: 'the typography CSS (published pages have no app stylesheet)',
      should: 'contain no var(--…) references',
      actual: /var\(--/.test(DOCUMENT_TYPOGRAPHY_CSS),
      expected: false,
    });
  });

  it('should scope every rule under .ps-document except page-canvas rules', () => {
    // :root/body are the deliberate page-canvas exceptions: this stylesheet is
    // only ever inlined into standalone published documents, and the canvas
    // must follow the color scheme or dark mode yields light-on-white text.
    const pageCanvasSelectors = new Set([':root', 'body', 'html']);
    const selectors = DOCUMENT_TYPOGRAPHY_CSS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]+\{/g, '')
      .replace(/\([^)]*\)/g, '()')
      .split('}')
      .map((chunk) => chunk.split('{')[0]?.trim())
      .filter((selector): selector is string => Boolean(selector));
    const unscoped = selectors
      .flatMap((selector) => selector.split(','))
      .map((part) => part.trim())
      .filter(
        (part) =>
          part.length > 0 && !part.startsWith('.ps-document') && !pageCanvasSelectors.has(part),
      );
    assert({
      given: 'every selector in the typography CSS',
      should: 'start with .ps-document (page-canvas :root/body rules excepted)',
      actual: unscoped,
      expected: [],
    });
  });

  it('should give the page canvas a background in both color schemes', () => {
    const [lightCss, darkCss] = DOCUMENT_TYPOGRAPHY_CSS.split('@media (prefers-color-scheme: dark)');
    assert({
      given: 'the page-canvas rules (published pages load no app stylesheet)',
      should: 'set an explicit light body background and a dark override, not foreground-only',
      actual:
        /body\s*\{[^}]*background:\s*#ffffff/s.test(lightCss ?? '') &&
        /body\s*\{[^}]*background:\s*#0d1117/s.test(darkCss ?? ''),
      expected: true,
    });
  });

  it('should declare color-scheme so UA defaults follow the scheme', () => {
    assert({
      given: 'the typography CSS',
      should: 'declare color-scheme: light dark on :root',
      actual: /:root\s*\{[^}]*color-scheme:\s*light dark/s.test(DOCUMENT_TYPOGRAPHY_CSS),
      expected: true,
    });
  });

  it('should reset UA margins before applying the document rhythm', () => {
    const resetIndex = DOCUMENT_TYPOGRAPHY_CSS.indexOf(':where(');
    const rhythmIndex = DOCUMENT_TYPOGRAPHY_CSS.indexOf('> * + *');
    const resetBlock = /\.ps-document\s+:where\(([^)]*)\)\s*\{[^}]*margin:\s*0/s.exec(
      DOCUMENT_TYPOGRAPHY_CSS,
    );
    const resetTargets = resetBlock?.[1] ?? '';
    assert({
      given: 'standalone output with browser default margins (no Tailwind Preflight)',
      should: 'zero UA margins on rich-text descendants via a low-specificity :where reset placed before the sibling rhythm',
      actual:
        resetIndex !== -1 &&
        rhythmIndex !== -1 &&
        resetIndex < rhythmIndex &&
        ['p', 'blockquote', 'figure', 'ul', 'h2'].every((tag) =>
          new RegExp(`(^|[,\\s])${tag}([,\\s]|$)`).test(resetTargets),
        ),
      expected: true,
    });
  });

  it('should style mention anchors as inline chips', () => {
    assert({
      given: 'the typography CSS',
      should: 'target a[data-mention-type] with chip styling (radius + background)',
      actual:
        DOCUMENT_TYPOGRAPHY_CSS.includes('a[data-mention-type]') &&
        /a\[data-mention-type\][^}]*border-radius/s.test(DOCUMENT_TYPOGRAPHY_CSS) &&
        /a\[data-mention-type\][^}]*background/s.test(DOCUMENT_TYPOGRAPHY_CSS),
      expected: true,
    });
  });

  it('should keep images inside the column', () => {
    assert({
      given: 'the typography CSS',
      should: 'cap img width at 100%',
      actual: /\.ps-document img[^}]*max-width: 100%/s.test(DOCUMENT_TYPOGRAPHY_CSS),
      expected: true,
    });
  });

  it('should cover the core rich-text elements', () => {
    const requiredSelectors = [
      '.ps-document h1',
      '.ps-document h2',
      '.ps-document h3',
      '.ps-document ul',
      '.ps-document ol',
      '.ps-document table',
      '.ps-document pre',
      '.ps-document code',
      '.ps-document blockquote',
      '.ps-document hr',
      '.ps-document a',
    ];
    assert({
      given: 'the typography CSS',
      should: 'include rules for headings, lists, tables, code, quotes, rules, and links',
      actual: requiredSelectors.filter((selector) => !DOCUMENT_TYPOGRAPHY_CSS.includes(selector)),
      expected: [],
    });
  });
});

describe('documentStartsWithH1', () => {
  it('should detect a leading <h1>', () => {
    assert({
      given: 'a body whose first element is <h1>',
      should: 'return true',
      actual: documentStartsWithH1('<h1>Title</h1><p>body</p>'),
      expected: true,
    });
  });

  it('should tolerate leading whitespace and HTML comments', () => {
    assert({
      given: 'a body with whitespace and comments before the <h1>',
      should: 'return true',
      actual: documentStartsWithH1('  \n<!-- generated -->\n <!-- two --> <h1>Title</h1>'),
      expected: true,
    });
  });

  it('should accept an <h1> that carries attributes', () => {
    assert({
      given: 'a body starting with <h1 class="…">',
      should: 'return true',
      actual: documentStartsWithH1('<h1 class="hero" id="top">Title</h1>'),
      expected: true,
    });
  });

  it('should be case-insensitive', () => {
    assert({
      given: 'a body starting with <H1>',
      should: 'return true',
      actual: documentStartsWithH1('<H1>Title</H1>'),
      expected: true,
    });
  });

  it('should reject a body starting with another element', () => {
    assert({
      given: 'a body starting with <h2>',
      should: 'return false',
      actual: documentStartsWithH1('<h2>Subtitle</h2>'),
      expected: false,
    });
  });

  it('should reject an <h1> that is not the first element', () => {
    assert({
      given: 'a body whose <h1> comes after a paragraph',
      should: 'return false',
      actual: documentStartsWithH1('<p>intro</p><h1>Late title</h1>'),
      expected: false,
    });
  });

  it('should reject empty and comment-only bodies', () => {
    assert({
      given: 'an empty body, whitespace, or comments with no content',
      should: 'return false for each',
      actual: [
        documentStartsWithH1(''),
        documentStartsWithH1('   \n\t '),
        documentStartsWithH1('<!-- nothing else -->'),
        documentStartsWithH1('<!-- unterminated'),
      ],
      expected: [false, false, false, false],
    });
  });
});

describe('wrapDocumentBody', () => {
  it('should wrap the body in a .ps-document article with a title header', () => {
    assert({
      given: 'a body with no leading <h1> and a title',
      should: 'emit <article class="ps-document"> with an <header><h1> before the body',
      actual: wrapDocumentBody({ bodyHtml: '<p>hello</p>', title: 'My Post' }),
      expected: '<article class="ps-document"><header><h1>My Post</h1></header><p>hello</p></article>',
    });
  });

  it('should suppress the header when the body already starts with an <h1>', () => {
    assert({
      given: 'a body whose first element is already an <h1>',
      should: 'not emit a duplicate title header',
      actual: wrapDocumentBody({ bodyHtml: '<h1>Own Title</h1><p>hello</p>', title: 'My Post' }),
      expected: '<article class="ps-document"><h1>Own Title</h1><p>hello</p></article>',
    });
  });

  it('should suppress the header when comments precede the <h1>', () => {
    assert({
      given: 'a body with leading whitespace/comments before its <h1>',
      should: 'not emit a duplicate title header',
      actual: wrapDocumentBody({
        bodyHtml: '\n<!-- exported --><h1>Own Title</h1>',
        title: 'My Post',
      }),
      expected: '<article class="ps-document">\n<!-- exported --><h1>Own Title</h1></article>',
    });
  });

  it('should HTML-escape the title', () => {
    assert({
      given: 'a title containing HTML-special characters',
      should: 'escape them in the emitted header',
      actual: wrapDocumentBody({ bodyHtml: '<p>x</p>', title: 'Fish & <Chips> "rated" 5\'s' }),
      expected:
        '<article class="ps-document"><header><h1>Fish &amp; &lt;Chips&gt; &quot;rated&quot; 5&#39;s</h1></header><p>x</p></article>',
    });
  });

  it('should keep the body verbatim', () => {
    const bodyHtml = '<p>a</p><ul><li>b</li></ul><pre><code>c()</code></pre>';
    assert({
      given: 'an arbitrary rich-text body',
      should: 'pass it through unmodified inside the article',
      actual: wrapDocumentBody({ bodyHtml, title: 'T' }).includes(bodyHtml),
      expected: true,
    });
  });
});
