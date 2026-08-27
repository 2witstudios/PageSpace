import { describe, it, expect, afterAll } from 'vitest';
import { getSchema } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { buildRichEditorExtensions } from '@/lib/editor/rich-editor-extensions';
import { createDomWorkspace } from '../constructs';
import { analyzeHtmlDocument, roundTripHtml } from '../round-trip';

const extensions = buildRichEditorExtensions({ readOnly: false, isPaginated: false });
const schema = getSchema(extensions);
const workspace = createDomWorkspace();
afterAll(() => workspace.close());

const analyse = (html: string) => analyzeHtmlDocument(html, schema, workspace);

describe('the schema the census measures', () => {
  it('is the one RichEditor mounts, and neither option changes it', () => {
    const base = getSchema(buildRichEditorExtensions({ readOnly: false, isPaginated: false }));
    for (const options of [
      { readOnly: true, isPaginated: false },
      { readOnly: false, isPaginated: true },
      { readOnly: true, isPaginated: true },
    ]) {
      const other = getSchema(buildRichEditorExtensions(options));
      expect(Object.keys(other.nodes)).toEqual(Object.keys(base.nodes));
      expect(Object.keys(other.marks)).toEqual(Object.keys(base.marks));
    }
  });
});

describe('roundTripHtml', () => {
  // The census drives ProseMirror itself rather than calling @tiptap/html's
  // generateJSON/generateHTML, which rebuild the schema and stand up two
  // throwaway happy-dom windows per document. That is only safe while the two
  // agree, so this holds the fast path against the sanctioned one.
  it.each([
    '<p>plain</p>',
    '<h2>head</h2><p><strong>a</strong> <em>b</em> <s>c</s></p>',
    '<p><a href="https://example.test">link</a></p>',
    '<ul><li><p>one</p></li><li><p>two</p></li></ul>',
    '<table><tbody><tr><td><p>cell</p></td></tr></tbody></table>',
    '<blockquote><p>quoted</p></blockquote><hr>',
    '<p>before</p><img src="https://example.test/a.png"><h5>five</h5>',
    '<ul data-type="taskList"><li data-checked="true"><p>task</p></li></ul>',
    '<p style="text-align: center"><mark>marked</mark><sup>up</sup></p>',
    '<span data-type="pageMention" data-id="p1" data-label="Page">@Page</span>',
  ])('matches @tiptap/html for %s', (html) => {
    expect(roundTripHtml(html, schema, workspace)).toBe(generateHTML(generateJSON(html, extensions), extensions));
  });
});

describe('analyzeHtmlDocument', () => {
  it('reports nothing dropped for content the schema fully represents', () => {
    const result = analyse('<p><strong>a</strong> <em>b</em></p><h2>c</h2>');
    expect(result).toMatchObject({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('does not call a document changed because the Link extension added attributes', () => {
    // TipTap stamps target/rel onto every <a> it parses. Byte comparison would
    // report every linked document as changed and bury the real signal.
    const result = analyse('<p><a href="https://example.test">link</a></p>');
    expect(result).toMatchObject({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('reports text loss when the round trip deletes words rather than unwrapping them', () => {
    // Most unknown elements unwrap and keep their text (<details> becomes a
    // paragraph); <object> is one whose contents ProseMirror discards outright.
    const result = analyse('<p>kept</p><object>lost</object>');
    expect(result).toMatchObject({ status: 'analysed', dropped: ['<object>'], textPreserved: false });
  });

  it('reports an <img> as dropped', () => {
    const result = analyse('<p>before</p><img src="https://example.test/a.png" alt="a">');
    expect(result.status === 'analysed' && result.dropped).toContain('<img>');
  });

  it('reports <h4>-<h6>, which the schema flattens to paragraphs', () => {
    const result = analyse('<h4>a</h4><h5>b</h5><h6>c</h6>');
    expect(result.status === 'analysed' && result.dropped).toEqual(['<h4>', '<h5>', '<h6>']);
  });

  it('reports task-list markup by its data-type value', () => {
    const result = analyse('<ul data-type="taskList"><li data-checked="true"><p>a</p></li></ul>');
    expect(result.status === 'analysed' && result.dropped).toContain('attr:data-type=taskList');
  });

  it('reports text-align, which survives on no node in this schema', () => {
    const result = analyse('<p style="text-align: center">a</p>');
    expect(result.status === 'analysed' && result.dropped).toContain('style:text-align');
  });

  it('reports <mark>, <sup> and <sub>', () => {
    const result = analyse('<p><mark>a</mark><sup>b</sup><sub>c</sub></p>');
    expect(result.status === 'analysed' && result.dropped).toEqual(['<mark>', '<sub>', '<sup>']);
  });

  it('keeps text a dropped wrapper was only wrapping', () => {
    // <div> unwraps to its children: the construct is named as dropped, the
    // words inside it are not lost.
    const result = analyse('<div><p>a</p></div>');
    expect(result).toMatchObject({ status: 'analysed', dropped: ['<div>'], textPreserved: true });
  });

  it('treats empty content as an intact round trip', () => {
    expect(analyse('')).toMatchObject({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('records only the error type when a document will not parse, never its content', () => {
    const exploding = { toString: () => { throw new TypeError('boom'); } } as unknown as string;
    const result = analyzeHtmlDocument(exploding, schema, workspace);
    expect(result).toEqual({ status: 'failed', errorName: 'TypeError' });
  });

  it('names a thrown non-Error without carrying its payload into the report', () => {
    const workspaceThatThrows = {
      ...workspace,
      parse: () => { throw 'secret document text'; },
    };
    const result = analyzeHtmlDocument('<p>a</p>', schema, workspaceThatThrows);
    expect(result).toEqual({ status: 'failed', errorName: 'unknown' });
  });
});

describe('mislabelled markdown, and what a stored document held', () => {
  it('reports a document with no HTML element at all as tagless', () => {
    const result = analyse('# a heading\n\n- one\n- two\n');
    expect(result.status === 'analysed' && result.tagless).toBe(true);
  });

  it('is still tagless when an unescaped angle bracket in prose parsed as an element', () => {
    // `Set<string>` in markdown source becomes a `<string>` element in the
    // parser. Counting that as HTML would hide the mislabelled page that is
    // most likely to be full of code samples.
    const result = analyse('# a\n\nreturns Set<string> for each row\n');
    expect(result.status === 'analysed' && result.tagless).toBe(true);
  });

  it('is not tagless when the document is real HTML', () => {
    const result = analyse('<p>a</p>');
    expect(result.status === 'analysed' && result.tagless).toBe(false);
  });

  it('reports where an <img> pointed, though the schema drops the node itself', () => {
    // The measurement is of the STORED document, not of what survives: the
    // point is what v1 would have to be able to represent.
    const result = analyse('<p>a</p><img src="https://cdn.example.test/a.png">');
    expect(result.status === 'analysed' && result.images).toEqual([
      { bucket: 'img-src:external-https', host: 'cdn.example.test' },
    ]);
    expect(result.status === 'analysed' && result.dropped).toContain('<img>');
  });

  it('measures the stored document rather than the round trip', () => {
    const result = analyse('<p>a</p><img src="a.png"><table><tr><td>1</td></tr><tr><td>2</td></tr></table>');
    expect(result.status === 'analysed' && result.magnitudes).toMatchObject({ images: 1, tableRows: 2 });
  });
});

describe('the constructs the census deliberately does not count', () => {
  it('keeps <s>, because the schema has the strike mark markdown maps onto', () => {
    // The reason `md:strikethrough` is not in the markdown tally: the gap it
    // claimed does not exist.
    const result = analyse('<p><s>struck</s></p>');
    expect(result.status === 'analysed' && result.dropped).toEqual([]);
  });
});
