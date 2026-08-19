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
