import { describe, expect, it } from 'vitest';
import { projectContent, resolveProjectionFormat } from '../text-projection';

const HTML_SAMPLE = `
  <h1>Title &amp; subtitle</h1>
  <p>The <strong>quick</strong> brown fox<br>jumps over.</p>
  <!-- a comment that must not surface -->
  <script>const leaked = "no";</script>
  <style>.leaked { color: red }</style>
  <ul><li>one</li><li>two</li></ul>
  <p data-attr="a > b">entity &#65;&#x42; and&nbsp;nbsp</p>
`;

const TIPTAP_SAMPLE = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'quick' },
        { type: 'text', text: ' brown fox' },
        { type: 'hardBreak' },
        { type: 'text', text: 'jumps over.' },
      ],
    },
  ],
});

describe('projectContent', () => {
  it('strips HTML tags and turns block elements into single newlines', () => {
    expect(projectContent(HTML_SAMPLE, 'html')).toBe(
      [
        'Title & subtitle',
        'The quick brown fox',
        'jumps over.',
        'one',
        'two',
        'entity AB and nbsp',
      ].join('\n')
    );
  });

  it('drops script and style contents entirely', () => {
    const projected = projectContent(HTML_SAMPLE, 'html');
    expect(projected).not.toContain('leaked');
    expect(projected).not.toContain('color: red');
    expect(projected).not.toContain('a comment');
  });

  it('does not let a > inside an attribute value end the tag early', () => {
    expect(projectContent('<p title="a > b">kept</p>', 'html')).toBe('kept');
  });

  it('treats a bare < that is not a tag as text', () => {
    expect(projectContent('<p>2 < 3 &lt; 4</p>', 'html')).toBe('2 < 3 < 4');
  });

  it('treats < followed by a letter as a tag, exactly as the HTML parser does', () => {
    // Looks like data loss, and is not: per the HTML tokenizer, `<` followed by
    // an ASCII letter enters the tag-open state, so a browser also drops
    // `<y then z is big>` as an unknown element and renders only "if x". The
    // projection has to mirror what the reader actually sees, or offsets would
    // index text nobody can point at. Escaping the `<` keeps it, as below.
    expect(projectContent('<p>if x<y then z is big</p>', 'html')).toBe('if x');
    expect(projectContent('<p>if x&lt;y then z is big</p>', 'html')).toBe('if x<y then z is big');
  });

  it('keeps reading a tag whose unquoted attribute value contains an apostrophe', () => {
    // A quote only opens where a value begins. Treating any quote character as
    // a delimiter opened a state that never closed, silently swallowing the
    // rest of the document and orphaning every anchor on the page.
    expect(projectContent("<div data-x=it's fine>hello world</div>", 'html')).toBe('hello world');
    expect(projectContent("<div data-x = 'y'>quoted</div>", 'html')).toBe('quoted');
    expect(projectContent('<div data-x = "y">quoted</div>', 'html')).toBe('quoted');
  });

  it('collapses the same characters in HTML and in tiptap, and only those', () => {
    // The two strategies have to agree character for character: a page
    // converted between storage formats would otherwise re-project into a
    // different coordinate system and shift every anchor on it. The regex \s
    // is too wide for the job — EM SPACE and the line separators are content.
    const asTiptap = (text: string) =>
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      });

    for (const collapsible of [' ', '\t', '\n', '\u00a0']) {
      const body = `a${collapsible}${collapsible}b`;
      expect(projectContent(`<p>${body}</p>`, 'html')).toBe('a b');
      expect(projectContent(asTiptap(body), 'html')).toBe('a b');
    }

    for (const kept of ['\u2003', '\u2028', '\u3000']) {
      // Padded with ordinary spaces on purpose: a wider split would swallow the
      // kept character into the surrounding run and collapse it away with them,
      // which an unpadded fixture cannot detect.
      const body = `a ${kept} b`;
      expect(projectContent(`<p>${body}</p>`, 'html')).toBe(body);
      expect(projectContent(asTiptap(body), 'html')).toBe(body);
      expect(projectContent(asTiptap(body), 'html')).toContain(kept);
    }
  });

  it('projects a literal non-breaking space exactly like &nbsp;', () => {
    // convert-content-mode round-trips through Turndown and marked and can swap
    // one encoding for the other. If they projected differently, that round
    // trip would silently shift every offset after the first one it touched.
    const entity = projectContent('<p>a&nbsp;b&nbsp;&nbsp;c</p>', 'html');
    const literal = projectContent('<p>a\u00a0b\u00a0\u00a0c</p>', 'html');

    expect(entity).toBe(literal);
    expect(entity).toBe('a b c');
    expect(entity).not.toContain('\u00a0');
  });

  it('does not decode a name that only exists on the object prototype', () => {
    // `&__proto__;` is short enough to pass the length guard, and an object
    // lookup would resolve it to Object.prototype — not undefined, so it was
    // accepted as a decoded value. It stringifies to '[object Object]', which
    // contains a space, so it was then classified as whitespace and swallowed,
    // putting every offset after it out by the length of the entity.
    expect(projectContent('<p>a&__proto__;b</p>', 'html')).toBe('a&__proto__;b');
    expect(projectContent('<p>a&valueOf;b</p>', 'html')).toBe('a&valueOf;b');
    expect(projectContent('<p>a&hasOwnProperty;b</p>', 'html')).toBe('a&hasOwnProperty;b');
    // The real entities still decode.
    expect(projectContent('<p>a&amp;b&nbsp;c</p>', 'html')).toBe('a&b c');
  });

  it('leaves code points Postgres cannot store as literal text', () => {
    // An anchor's `exact` ends up in a jsonb column, and neither NUL nor a lone
    // surrogate survives that. Decoding them would produce a projection that
    // cannot be persisted at all.
    expect(projectContent('<p>a&#0;b</p>', 'html')).toBe('a&#0;b');
    expect(projectContent('<p>a&#xD800;b</p>', 'html')).toBe('a&#xD800;b');
    expect(projectContent('<p>a&#xDFFF;b</p>', 'html')).toBe('a&#xDFFF;b');
    // A real astral character still decodes.
    expect(projectContent('<p>a&#x1F600;b</p>', 'html')).toBe('a\u{1F600}b');
  });

  it('drops raw-text elements whatever their case', () => {
    expect(projectContent('<p>a</p><SCRIPT>bad</SCRIPT><p>b</p>', 'html')).toBe('a\nb');
    expect(projectContent('<p>a</p><StYlE>.x{}</StYlE><p>b</p>', 'html')).toBe('a\nb');
  });

  it('does not end a raw-text element on a tag that merely starts with its name', () => {
    // `</scripture>` begins with `script`. Accepting it would stop the skip
    // early and project the rest of the script body as visible prose.
    expect(projectContent('<p>a</p><script>x</scripture>leaked</script><p>b</p>', 'html')).toBe(
      'a\nb'
    );
    expect(projectContent('<p>a</p><style>i</styles>leaked</style><p>b</p>', 'html')).toBe('a\nb');
  });

  it('leaves an unterminated comment, doctype or raw-text element harmless', () => {
    // Note both fixtures must still end in '>': detectPageContentFormat only
    // calls content HTML when it both starts with '<' and ends with '>'.
    expect(projectContent('<!doctype html><p>a</p><!-- never closed>', 'html')).toBe('a');
    expect(projectContent('<p>a</p><script>never closed>', 'html')).toBe('a');
  });

  it('passes through an unrecognised or malformed entity as literal text', () => {
    expect(projectContent('<p>AT&T &notanentity; &#zz; 100&amp;</p>', 'html')).toBe(
      'AT&T &notanentity; &#zz; 100&'
    );
    // No semicolon at all, and a "name" too long to be one.
    expect(projectContent('<p>a &b c &averyverylongthing; d &#999999999999;</p>', 'html')).toBe(
      'a &b c &averyverylongthing; d &#999999999999;'
    );
  });

  it('flattens a tiptap document to its text nodes with block boundaries', () => {
    expect(projectContent(TIPTAP_SAMPLE, 'html')).toBe('Title\nThe quick brown fox\njumps over.');
  });

  it('skips null and primitive entries inside a tiptap content array', () => {
    const ragged = JSON.stringify({
      type: 'doc',
      content: [null, 5, 'stray', { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }],
    });
    expect(projectContent(ragged, 'html')).toBe('kept');
  });

  it('treats a truncated tiptap blob as plain text — the sniffer never calls it tiptap', () => {
    const truncated = '{"type":"doc","content":[';
    expect(resolveProjectionFormat(truncated, 'html')).toBe('text');
    expect(projectContent(truncated, 'html')).toBe(truncated);
  });

  it('normalises CRLF in plain text and leaves everything else alone', () => {
    expect(projectContent('one\r\ntwo\rthree\n  four  ', 'markdown')).toBe(
      'one\ntwo\nthree\n  four  '
    );
  });

  it('returns non-tiptap JSON as the stored blob — sheets anchor by natural key', () => {
    const json = '{"sheets":[{"name":"S1"}]}';
    expect(projectContent(json, 'html')).toBe(json);
  });

  it('returns the empty string for empty content', () => {
    expect(projectContent('', 'html')).toBe('');
  });

  it('does not strip markup-looking prose from a markdown page', () => {
    const markdown = '<not really a tag>';
    expect(resolveProjectionFormat(markdown, 'html')).toBe('html');
    expect(resolveProjectionFormat(markdown, 'markdown')).toBe('text');
    expect(projectContent(markdown, 'markdown')).toBe(markdown);
    expect(projectContent(markdown, 'html')).toBe('');
  });

  it('renders an empty tiptap document as the empty string', () => {
    expect(projectContent('{"type":"doc","content":[]}', 'html')).toBe('');
  });

  it('sniffs format per revision, which can flip mid-edit — a caller-side hazard', () => {
    // detectPageContentFormat only calls content HTML when the trimmed body
    // both starts with '<' AND ends with '>'. Unclosed trailing markup — routine
    // in imported HTML and reachable mid-edit — therefore projects in a
    // different coordinate system from the same page a revision earlier.
    // Pinned rather than fixed: the sniffer is shared with diff-utils and
    // others, and the durable fix is a stored per-page format, which arrives
    // with the schema in a later phase. Until then a caller must confirm both
    // sides projected the same way before trusting a port — resolveProjectionFormat
    // is exported for exactly that, and anchor.textHash catches the rest.
    expect(projectContent('<p>one</p>', 'html')).toBe('one');
    expect(resolveProjectionFormat('<p>one</p>', 'html')).toBe('html');

    expect(resolveProjectionFormat('<p>one</p><p>tail text', 'html')).toBe('text');
    expect(projectContent('<p>one</p><p>tail text', 'html')).toBe('<p>one</p><p>tail text');
  });

  it('is deterministic: identical input yields identical output across formats', () => {
    const cases: Array<[string, string]> = [
      [HTML_SAMPLE, 'html'],
      [TIPTAP_SAMPLE, 'html'],
      ['plain\r\ntext', 'markdown'],
      ['{"a":1}', 'html'],
      ['', 'html'],
    ];

    for (const [content, mode] of cases) {
      const first = projectContent(content, mode);
      for (let i = 0; i < 5; i += 1) {
        expect(projectContent(content, mode)).toBe(first);
      }
      // Same input reconstructed from parts must project identically too — the
      // projection depends on the string value, never on identity or ordering.
      expect(projectContent(content.split('').join(''), mode)).toBe(first);
    }
  });
});
