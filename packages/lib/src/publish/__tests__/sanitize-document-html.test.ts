import { describe, it, expect } from 'vitest';
import { sanitizeDocumentHtml } from '../sanitize-document-html';

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

describe('sanitizeDocumentHtml', () => {
  describe('script stripping', () => {
    it('strips a plain script block, tag and content', () => {
      assert({
        given: 'HTML with a <script> block between paragraphs',
        should: 'remove the whole block (tag + content)',
        actual: sanitizeDocumentHtml('<p>a</p><script>alert(1)</script><p>b</p>'),
        expected: '<p>a</p><p>b</p>',
      });
    });

    it('strips mixed-case script tags with attributes', () => {
      assert({
        given: 'a <SCRIPT> with attributes and mixed-case close tag',
        should: 'remove the whole block',
        actual: sanitizeDocumentHtml(
          '<p>x</p><SCRIPT type="text/javascript" src="https://evil.example/x.js">bad()</ScRiPt><p>y</p>'
        ),
        expected: '<p>x</p><p>y</p>',
      });
    });

    it('strips a script left unclosed at EOF', () => {
      assert({
        given: 'a <script> that is never closed',
        should: 'remove everything from the open tag to EOF',
        actual: sanitizeDocumentHtml('<p>a</p><script>alert(1)'),
        expected: '<p>a</p>',
      });
    });

    it('strips a close tag padded with junk', () => {
      assert({
        given: 'a script closed by `</script foo="bar">`',
        should: 'still find the close tag and remove the block',
        actual: sanitizeDocumentHtml('<p>a</p><script>alert(1)</script foo="bar"><p>b</p>'),
        expected: '<p>a</p><p>b</p>',
      });
    });

    it('does not mistake hyphenated custom elements for scripts', () => {
      assert({
        given: 'a <script-template> custom element',
        should: 'leave it untouched (tag name requires a real delimiter)',
        actual: sanitizeDocumentHtml('<script-template><p>hi</p></script-template>'),
        expected: '<script-template><p>hi</p></script-template>',
      });
    });

    it('defeats the split-tag reassembly trick', () => {
      const out = sanitizeDocumentHtml('<<script>x</script>script src="https://evil.example/x.js">alert(1)</script>');
      assert({
        given: 'a payload whose script tag reassembles after one strip pass',
        should: 'leave no executable <script open tag in the output',
        actual: /<script(?=[\s/>])/i.test(out),
        expected: false,
      });
    });
  });

  describe('forbidden elements', () => {
    it('strips iframes with their content', () => {
      assert({
        given: 'an <iframe> with fallback content',
        should: 'remove the element entirely',
        actual: sanitizeDocumentHtml('<p>a</p><iframe src="https://evil.example">fallback</iframe><p>b</p>'),
        expected: '<p>a</p><p>b</p>',
      });
    });

    it('strips object and embed elements', () => {
      assert({
        given: '<object> and <embed> elements',
        should: 'remove both',
        actual: sanitizeDocumentHtml('<object data="x.swf">o</object><p>keep</p><embed src="x.swf">'),
        expected: '<p>keep</p>',
      });
    });

    it('strips form elements', () => {
      assert({
        given: 'a <form> wrapping inputs',
        should: 'remove the form element entirely',
        actual: sanitizeDocumentHtml('<p>a</p><form action="/steal"><input name="pw"></form><p>b</p>'),
        expected: '<p>a</p><p>b</p>',
      });
    });

    it('strips base, meta and link tags', () => {
      assert({
        given: 'void head-manipulation tags (<base>, <meta>, <link>)',
        should: 'remove all of them',
        actual: sanitizeDocumentHtml(
          '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=x"><link rel="stylesheet" href="x.css"><p>keep</p>'
        ),
        expected: '<p>keep</p>',
      });
    });

    it('strips style blocks with their content', () => {
      assert({
        given: 'a <style> block (documents are styled by the shell)',
        should: 'remove tag and CSS content',
        actual: sanitizeDocumentHtml('<style>p { display: none; }</style><p>keep</p>'),
        expected: '<p>keep</p>',
      });
    });

    it('strips a style block left unclosed at EOF', () => {
      assert({
        given: 'a <style> that is never closed',
        should: 'remove everything from the open tag to EOF',
        actual: sanitizeDocumentHtml('<p>a</p><style>p{}'),
        expected: '<p>a</p>',
      });
    });

    it('strips mixed-case forbidden elements', () => {
      assert({
        given: 'an <IFRAME> in caps',
        should: 'remove it (matching is case-insensitive)',
        actual: sanitizeDocumentHtml('<IFRAME SRC="x"></IFRAME><p>keep</p>'),
        expected: '<p>keep</p>',
      });
    });
  });

  describe('event handler attributes', () => {
    it('removes on* attributes but keeps the element', () => {
      assert({
        given: 'an <img> with an onerror handler',
        should: 'drop the handler, keep the element and its other attributes',
        actual: sanitizeDocumentHtml('<img src="x.png" onerror="alert(1)" alt="pic">'),
        expected: '<img src="x.png" alt="pic">',
      });
    });

    it('removes on* attributes in any casing', () => {
      assert({
        given: 'a <div ONCLICK=...> in caps',
        should: 'remove the attribute regardless of case',
        actual: sanitizeDocumentHtml("<div ONCLICK='alert(1)'>hi</div>"),
        expected: '<div>hi</div>',
      });
    });

    it('removes unquoted on* attribute values', () => {
      assert({
        given: 'an unquoted onmouseover value',
        should: 'remove the whole attribute',
        actual: sanitizeDocumentHtml('<a onmouseover=alert(1) href="/ok">x</a>'),
        expected: '<a href="/ok">x</a>',
      });
    });

    it('does not remove data-* attributes that merely contain "on"', () => {
      assert({
        given: 'a span with data-mention-type (contains "on" but is not a handler)',
        should: 'keep the attribute',
        actual: sanitizeDocumentHtml('<span data-mention-type="page">@Home</span>'),
        expected: '<span data-mention-type="page">@Home</span>',
      });
    });

    it('handles a ">" inside a quoted attribute value before the handler', () => {
      assert({
        given: 'an element whose alt contains ">" followed by an onerror',
        should: 'parse the tag quote-aware and still remove the handler',
        actual: sanitizeDocumentHtml('<img alt="a>b" onerror="alert(1)" src="x.png">'),
        expected: '<img alt="a>b" src="x.png">',
      });
    });
  });

  describe('dangerous URL schemes', () => {
    it('removes javascript: hrefs', () => {
      assert({
        given: 'an anchor with a javascript: href',
        should: 'remove the href attribute, keep the anchor',
        actual: sanitizeDocumentHtml('<a href="javascript:alert(1)">x</a>'),
        expected: '<a>x</a>',
      });
    });

    it('removes javascript: hrefs with case and whitespace tricks', () => {
      assert({
        given: 'a href of " JaVaScRiPt:..." with leading space and mixed case',
        should: 'still detect and remove it',
        actual: sanitizeDocumentHtml('<a href=" JaVaScRiPt:alert(1)">x</a>'),
        expected: '<a>x</a>',
      });
    });

    it('removes javascript: hrefs with embedded tab/newline', () => {
      assert({
        given: 'a href with a tab and newline inside the scheme (browser strips them)',
        should: 'still detect and remove it',
        actual: sanitizeDocumentHtml('<a href="java\tscri\npt:alert(1)">x</a>'),
        expected: '<a>x</a>',
      });
    });

    it('removes javascript: hidden behind HTML entities', () => {
      assert({
        given: 'a href spelling javascript: with numeric/named entities',
        should: 'decode for the check and remove it',
        actual: sanitizeDocumentHtml('<a href="&#106;avascript&colon;alert(1)">x</a>'),
        expected: '<a>x</a>',
      });
    });

    it('removes data:text/html srcs and hrefs', () => {
      assert({
        given: 'a href with a data:text/html payload (any casing)',
        should: 'remove the attribute',
        actual: sanitizeDocumentHtml('<a href="DATA:text/html;base64,PHNjcmlwdD4=">x</a>'),
        expected: '<a>x</a>',
      });
    });

    it('keeps benign URL schemes', () => {
      const benign =
        '<a href="https://example.com/a">a</a>' +
        '<a href="/relative/path">b</a>' +
        '<a href="mailto:hi@example.com">c</a>' +
        '<img src="data:image/png;base64,iVBORw0KGgo=">';
      assert({
        given: 'https, relative, mailto and data:image URLs',
        should: 'pass them through untouched',
        actual: sanitizeDocumentHtml(benign),
        expected: benign,
      });
    });
  });

  describe('benign TipTap output', () => {
    const tiptap =
      '<h1>Title</h1>' +
      '<h2>Sub</h2><h3>a</h3><h4>b</h4><h5>c</h5><h6>d</h6>' +
      '<p>Hello <strong>bold</strong> and <em>italic</em> text.</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<ol><li>first</li></ol>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>' +
      '<img src="https://cdn.example.com/img.png" alt="pic" width="100">' +
      '<a href="https://example.com" target="_blank" rel="noopener">link</a>' +
      '<pre><code>const x = 1 &lt; 2;</code></pre>' +
      '<blockquote><p>quote</p></blockquote>' +
      '<hr>' +
      '<p><span data-mention-type="page" data-id="abc123">@Home</span></p>';

    it('passes benign TipTap output through byte-identical', () => {
      assert({
        given: 'typical TipTap-authored document HTML',
        should: 'return it byte-identical',
        actual: sanitizeDocumentHtml(tiptap),
        expected: tiptap,
      });
    });
  });

  describe('idempotence', () => {
    const nastyInputs = [
      '<p>a</p><script>alert(1)</script><p>b</p>',
      '<<script>x</script>script src="x">alert(1)</script>',
      '<img src="x.png" onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<style>p{}</style><iframe src="x"></iframe><form><input></form>',
      '<scri<script></script>pt>alert(1)</scri</script>ipt>',
      '<p>plain</p>',
    ];

    it('is idempotent on every input', () => {
      for (const input of nastyInputs) {
        const once = sanitizeDocumentHtml(input);
        assert({
          given: `input ${JSON.stringify(input.slice(0, 40))}…`,
          should: 'satisfy sanitize(sanitize(x)) === sanitize(x)',
          actual: sanitizeDocumentHtml(once),
          expected: once,
        });
      }
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      assert({
        given: 'an empty string',
        should: 'return an empty string',
        actual: sanitizeDocumentHtml(''),
        expected: '',
      });
    });

    it('leaves a bare "<" literal alone', () => {
      assert({
        given: 'text containing a stray "<" that is not a tag',
        should: 'pass it through',
        actual: sanitizeDocumentHtml('<p>1 < 2 is true</p>'),
        expected: '<p>1 < 2 is true</p>',
      });
    });

    it('strips orphan close tags of forbidden elements', () => {
      assert({
        given: 'a stray </script> with no matching open tag',
        should: 'remove it',
        actual: sanitizeDocumentHtml('<p>a</p></script><p>b</p>'),
        expected: '<p>a</p><p>b</p>',
      });
    });
  });
});
