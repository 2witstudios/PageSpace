import { describe, it, expect, afterAll } from 'vitest';
import { getSchema } from '@tiptap/core';
import { buildRichEditorExtensions } from '@/lib/editor/rich-editor-extensions';
import { createConstructScanner } from '../constructs';
import { analyzeHtmlDocument } from '../round-trip';

const extensions = buildRichEditorExtensions({ readOnly: false, isPaginated: false });
const scanner = createConstructScanner();
afterAll(() => scanner.close());

const analyse = (html: string) => analyzeHtmlDocument(html, extensions, scanner);

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

describe('analyzeHtmlDocument', () => {
  it('reports nothing dropped for content the schema fully represents', () => {
    const result = analyse('<p><strong>a</strong> <em>b</em></p><h2>c</h2>');
    expect(result).toEqual({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('does not call a document changed because the Link extension added attributes', () => {
    // TipTap stamps target/rel onto every <a> it parses. Byte comparison would
    // report every linked document as changed and bury the real signal.
    const result = analyse('<p><a href="https://example.test">link</a></p>');
    expect(result).toEqual({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('reports text loss when the round trip deletes words rather than unwrapping them', () => {
    // Most unknown elements unwrap and keep their text (<details> becomes a
    // paragraph); <object> is one whose contents ProseMirror discards outright.
    const result = analyse('<p>kept</p><object>lost</object>');
    expect(result).toEqual({ status: 'analysed', dropped: ['<object>'], textPreserved: false });
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
    expect(result).toEqual({ status: 'analysed', dropped: ['<div>'], textPreserved: true });
  });

  it('treats empty content as an intact round trip', () => {
    expect(analyse('')).toEqual({ status: 'analysed', dropped: [], textPreserved: true });
  });

  it('records only the error type when a document will not parse, never its content', () => {
    const exploding = { toString: () => { throw new TypeError('boom'); } } as unknown as string;
    const result = analyzeHtmlDocument(exploding, extensions, scanner);
    expect(result).toEqual({ status: 'failed', errorName: 'TypeError' });
  });

  it('names a thrown non-Error without carrying its payload into the report', () => {
    const scannerThatThrows = {
      scan: () => { throw 'secret document text'; },
      close: () => {},
    };
    const result = analyzeHtmlDocument('<p>a</p>', extensions, scannerThatThrows);
    expect(result).toEqual({ status: 'failed', errorName: 'unknown' });
  });
});
