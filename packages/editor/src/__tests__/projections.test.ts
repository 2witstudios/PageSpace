/**
 * The four projections, over the shared construct corpus.
 *
 * `pages.content` is not the editor's private field — it is a public
 * integration surface (search, AI context, export, publish, `syncMentions`,
 * backups, tenant export). These projections are written on every flush,
 * forever, so a projector that silently drops a construct corrupts documents
 * at scale with no failing test anywhere. That is what this suite exists to
 * make impossible.
 */
import { describe, it, expect } from 'vitest';
import { Schema } from 'prosemirror-model';
import { htmlToPmDoc, htmlToYDoc } from '../html-to-ydoc.js';
import { pmDocToHtml, yDocToHtml } from '../y-doc-to-html.js';
import { pmDocToText, yDocToText } from '../y-doc-to-text.js';
import { pmDocToMarkdown, yDocToMarkdown } from '../y-doc-to-markdown.js';
import { pmDocToBlocks, yDocToBlocks } from '../y-doc-to-blocks.js';
import { UnknownNodeError } from '../projection-errors.js';
import { CORPUS_CASES, corpusDocumentHtml } from './support/construct-corpus.js';

const corpusHtml = corpusDocumentHtml();
const corpusDoc = htmlToPmDoc(corpusHtml);

describe('the Y.Doc projections agree with the ProseMirror ones', () => {
  const yDoc = htmlToYDoc(corpusHtml);

  it('renders the same HTML through the CRDT as directly', () => {
    expect(yDocToHtml(yDoc)).toBe(pmDocToHtml(corpusDoc));
  });

  it('renders the same text, markdown and blocks through the CRDT', () => {
    expect(yDocToText(yDoc)).toBe(pmDocToText(corpusDoc));
    expect(yDocToMarkdown(yDoc)).toBe(pmDocToMarkdown(corpusDoc));
    expect(yDocToBlocks(yDoc)).toEqual(pmDocToBlocks(corpusDoc));
  });
});

describe('text projection', () => {
  const text = pmDocToText(corpusDoc);

  /**
   * The live defect this projection exists to fix:
   * `apps/web/src/app/api/search/route.ts` `ILIKE`s raw HTML, so a query for
   * `span` matches every document containing a styled span. The corpus is full
   * of `<span style>`, `<a href>`, `<table>` and `data-*` attributes and none
   * of those words may appear in the output.
   */
  it.each(['span', 'href', 'style', 'table', 'class', 'data-', '<', '>', 'colspan'])(
    'does not match a search for the markup token %j',
    (token) => {
      expect(text.toLowerCase()).not.toContain(token);
    },
  );

  it.each(CORPUS_CASES)(
    'keeps every visible string of %s',
    (_key, fixture) => {
      for (const expected of fixture.text) {
        expect(text).toContain(expected);
      }
    },
  );

  it('separates blocks so two paragraphs cannot form a phrase', () => {
    // `Element.textContent` would join these into "aboveblue"; the projection
    // must not, or a search for a phrase spanning a block boundary hits.
    const projected = pmDocToText(htmlToPmDoc('<p>above</p><p>blue</p>'));
    expect(projected).toBe('above\nblue');
  });

  it('separates table cells within a row and rows from each other', () => {
    const projected = pmDocToText(
      htmlToPmDoc(
        '<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr>' +
          '<tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>',
      ),
    );
    expect(projected).toBe('a\tb\nc\td');
  });

  it('keeps a code block\'s own line breaks', () => {
    const projected = pmDocToText(htmlToPmDoc('<pre><code>one\ntwo</code></pre>'));
    expect(projected).toBe('one\ntwo');
  });

  it('renders a mention as its visible label, never its id', () => {
    const projected = pmDocToText(
      htmlToPmDoc(
        '<p><a class="mention" data-mention-type="page" data-page-id="pg_secret">@Roadmap</a></p>',
      ),
    );
    expect(projected).toBe('@Roadmap');
    expect(projected).not.toContain('pg_secret');
  });

  it('contributes nothing for a mention with no label — never the word "null"', () => {
    // `label` defaults to `null` in the frozen schema. Stringifying it without
    // narrowing puts the literal `@null` into the search corpus, and emitting
    // the id instead would let a CUID-shaped query match every document that
    // merely links to a page.
    const doc = corpusDoc.type.schema;
    const mention = doc.node('doc', null, [
      doc.node('paragraph', null, [doc.node('pageMention', { id: 'pg_1', label: null })]),
    ]);
    expect(pmDocToText(mention)).toBe('');
    expect(pmDocToMarkdown(mention).trim()).toBe('');
  });

  it('contributes nothing for an image, so alt text cannot answer a prose query', () => {
    expect(pmDocToText(htmlToPmDoc('<img data-file-id="f1" alt="a diagram">'))).toBe('');
  });
});

describe('markdown projection', () => {
  const markdown = pmDocToMarkdown(corpusDoc);
  const html = pmDocToHtml(corpusDoc);

  /**
   * "Materially cheaper in tokens" is asserted through two independent
   * proxies — characters, and whitespace/punctuation-delimited words — rather
   * than a real tokenizer. Adding a tokenizer dependency to a package that
   * ships in every production image, for one assertion, costs more than it
   * proves; and the gap being measured here is a factor, not a few per cent,
   * so no tokenizer's exact segmentation could reverse it.
   */
  it('costs materially fewer characters than the HTML', () => {
    expect(markdown.length).toBeLessThan(html.length * 0.6);
  });

  it('costs materially fewer word-ish tokens than the HTML', () => {
    const tokens = (text: string): number => text.split(/[\s<>="/]+/u).filter(Boolean).length;
    expect(tokens(markdown)).toBeLessThan(tokens(html) * 0.6);
  });

  it.each(CORPUS_CASES)(
    'keeps every visible string of %s',
    (_key, fixture) => {
      for (const expected of fixture.text) {
        expect(markdown).toContain(expected);
      }
    },
  );

  it('emits headings 1 to 6 at their own levels', () => {
    expect(pmDocToMarkdown(htmlToPmDoc('<h1>a</h1><h4>b</h4><h6>c</h6>')).trim()).toBe(
      '# a\n\n#### b\n\n###### c',
    );
  });

  it('fences a code block with its language', () => {
    expect(
      pmDocToMarkdown(
        htmlToPmDoc('<pre><code class="language-typescript">const a = 1;</code></pre>'),
      ).trim(),
    ).toBe('```typescript\nconst a = 1;\n```');
  });

  it('fences a code block that itself contains a triple backtick', () => {
    const projected = pmDocToMarkdown(
      htmlToPmDoc('<pre><code>```\nnested\n```</code></pre>'),
    ).trim();
    expect(projected.startsWith('````')).toBe(true);
    expect(projected.endsWith('````')).toBe(true);
  });

  it('renders a tight list tightly and a loose list loosely', () => {
    expect(pmDocToMarkdown(htmlToPmDoc('<ul><li>a</li><li>b</li></ul>')).trim()).toBe('- a\n- b');
    expect(
      pmDocToMarkdown(htmlToPmDoc('<ul><li><p>a</p></li><li><p>b</p></li></ul>')).trim(),
    ).toBe('- a\n\n- b');
  });

  it('numbers an ordered list from its start attribute', () => {
    expect(pmDocToMarkdown(htmlToPmDoc('<ol start="7"><li>a</li><li>b</li></ol>')).trim()).toBe(
      '7. a\n8. b',
    );
  });

  it('renders task items with their checked state', () => {
    expect(
      pmDocToMarkdown(
        htmlToPmDoc(
          '<ul data-type="taskList">' +
            '<li data-type="taskItem" data-checked="true"><p>done</p></li>' +
            '<li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>',
        ),
      ).trim(),
    ).toBe('- [x] done\n- [ ] todo');
  });

  it('renders a table as GFM, with its header row and alignment', () => {
    expect(
      pmDocToMarkdown(
        htmlToPmDoc(
          '<table><tbody><tr><th style="text-align: right"><p>N</p></th><th><p>R</p></th></tr>' +
            '<tr><td><p>Ada</p></td><td><p>Eng</p></td></tr></tbody></table>',
        ),
      ).trim(),
    ).toBe('| N | R |\n| ---: | --- |\n| Ada | Eng |');
  });

  it('escapes a pipe inside a cell so it cannot forge a column', () => {
    const projected = pmDocToMarkdown(
      htmlToPmDoc('<table><tbody><tr><td><p>a|b</p></td></tr></tbody></table>'),
    );
    expect(projected).toContain('a\\|b');
  });

  it('pads every row to the widest row, so a short row cannot shift columns', () => {
    // A ragged table is legal in the schema. Sizing the table from the FIRST
    // row instead of the widest silently truncates every wider row's cells —
    // content loss that reads as a well-formed table.
    expect(
      pmDocToMarkdown(
        htmlToPmDoc(
          '<table><tbody><tr><td><p>a</p></td></tr>' +
            '<tr><td><p>b</p></td><td><p>c</p></td></tr></tbody></table>',
        ),
      ).trim(),
    ).toBe('|  |  |\n| --- | --- |\n| a |  |\n| b | c |');
  });

  it('emits an empty header when the table has no header row', () => {
    expect(
      pmDocToMarkdown(
        htmlToPmDoc('<table><tbody><tr><td><p>only</p></td></tr></tbody></table>'),
      ).trim(),
    ).toBe('|  |\n| --- |\n| only |');
  });

  it('renders an image with no alt and no file id without emitting "null"', () => {
    // Both attributes default to `null` in the schema (`alt` distinguishes
    // "explicitly decorative" from "unset"), and interpolating a null into the
    // markdown would put the word `null` into the AI's context.
    expect(pmDocToMarkdown(htmlToPmDoc('<img data-file-id="">')).trim()).toBe(
      '![](pagespace-file:)',
    );
  });

  it('numbers a list declared to start at zero from one', () => {
    // Markdown has no zero-indexed ordered list; `start="0"` is legal HTML.
    expect(pmDocToMarkdown(htmlToPmDoc('<ol start="0"><li>a</li></ol>')).trim()).toBe('1. a');
  });

  it('renders a link mark carrying no href as an empty target, not "null"', () => {
    const doc = htmlToPmDoc('<p>x</p>');
    const schema = doc.type.schema;
    const linked = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('x', [schema.mark('link', { href: null })])]),
    ]);
    expect(pmDocToMarkdown(linked).trim()).toBe('[x]()');
  });

  it('serializes a bare table fragment rather than throwing', () => {
    // `table` builds its own pipe markup and never renders rows through the
    // serializer, so the row and cell entries are off that path — but they are
    // what makes a table PROJECTABLE at all, and this is what exercises them.
    const table = htmlToPmDoc(
      '<table><tbody><tr><th><p>head</p></th></tr><tr><td><p>cell</p></td></tr></tbody></table>',
    ).child(0);
    expect(pmDocToMarkdown(table).trim()).toBe('head\n\ncell');
  });

  it('renders an image as its file reference, never a URL', () => {
    const projected = pmDocToMarkdown(
      htmlToPmDoc('<img data-file-id="file_abc" alt="a diagram">'),
    ).trim();
    expect(projected).toBe('![a diagram](pagespace-file:file_abc)');
  });

  it('renders marks it can express, and passes the rest through transparently', () => {
    expect(
      pmDocToMarkdown(
        htmlToPmDoc(
          '<p><strong>b</strong> <em>i</em> <s>s</s> <code>c</code> ' +
            '<a href="https://x.test/p">l</a></p>',
        ),
      ).trim(),
    ).toBe('**b** *i* ~~s~~ `c` [l](https://x.test/p)');
    // underline / highlight / textStyle have no markdown form. The TEXT must
    // survive; only the annotation is dropped.
    expect(
      pmDocToMarkdown(
        htmlToPmDoc(
          '<p><u>under</u> <mark>high</mark> <span style="color: #f00">red</span></p>',
        ),
      ).trim(),
    ).toBe('under high red');
  });
});

describe('blocks projection', () => {
  it('addresses top-level blocks by their stable blockId', () => {
    const blocks = pmDocToBlocks(
      htmlToPmDoc('<p data-block-id="blk_1">one</p><h2 data-block-id="blk_2">two</h2>'),
    );
    expect(blocks).toEqual([
      { blockId: 'blk_1', type: 'paragraph', index: 0, text: 'one', markdown: 'one' },
      { blockId: 'blk_2', type: 'heading', index: 1, text: 'two', markdown: '## two' },
    ]);
  });

  it('reports a block with no id as null rather than falling back to its index', () => {
    expect(pmDocToBlocks(htmlToPmDoc('<p>no id</p>'))[0].blockId).toBeNull();
  });

  it('treats an EMPTY blockId as no id, not as an id', () => {
    // An empty string is not an addressable identity: returned as a string it
    // would let a caller treat "no id" as an id and address the wrong block.
    // (HTML parsing folds `data-block-id=""` to null on its own, so this can
    // only be reached by constructing the node directly — which is exactly why
    // the narrowing has to live in one named place.)
    const schema = htmlToPmDoc('<p>x</p>').type.schema;
    const doc = schema.node('doc', null, [schema.node('paragraph', { blockId: '' })]);
    expect(pmDocToBlocks(doc)[0].blockId).toBeNull();
  });

  it('keeps a list as ONE block rather than flattening it to its items', () => {
    const blocks = pmDocToBlocks(htmlToPmDoc('<ul><li>a</li><li>b</li></ul>'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('bulletList');
    expect(blocks[0].markdown).toBe('- a\n- b');
  });

  it('renders each block as its own root, with its own markup', () => {
    // Serialized as a bare node this heading would lose its `##` — the
    // serializer renders its argument's CHILDREN.
    const blocks = pmDocToBlocks(htmlToPmDoc('<h3>heading</h3><blockquote><p>q</p></blockquote>'));
    expect(blocks.map((block) => block.markdown)).toEqual(['### heading', '> q']);
  });

  it('covers every top-level block of the corpus', () => {
    expect(pmDocToBlocks(corpusDoc)).toHaveLength(corpusDoc.childCount);
  });
});

describe('fail closed', () => {
  /**
   * A node the frozen schema does not describe. Every projector must THROW
   * rather than skip it: a projector that degrades silently makes search go
   * permanently stale, and a lossy projection written once is indistinguishable
   * from a document that legitimately lacked the content.
   */
  const foreignSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      mystery: { group: 'block', atom: true },
      text: { group: 'inline' },
    },
    marks: {},
  });
  const foreignDoc = foreignSchema.node('doc', null, [foreignSchema.node('mystery')]);

  it.each([
    ['text', () => pmDocToText(foreignDoc)],
    ['html', () => pmDocToHtml(foreignDoc)],
    ['markdown', () => pmDocToMarkdown(foreignDoc)],
    ['blocks', () => pmDocToBlocks(foreignDoc)],
  ])('the %s projection throws on an unknown node', (_name, project) => {
    expect(project).toThrow(UnknownNodeError);
    expect(project).toThrow(/mystery/u);
  });

  it('names the projection it refused, so a caller can tell which one failed', () => {
    try {
      pmDocToMarkdown(foreignDoc);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownNodeError);
      expect((error as UnknownNodeError).nodeName).toBe('mystery');
      expect((error as UnknownNodeError).projection).toBe('markdown');
    }
  });

  it('throws on an unrecognised ROOT node, which `descendants` never visits', () => {
    // `Node.descendants` does not visit the node it is called on, so a guard
    // built only from it accepts ANY root. A document whose top node the
    // projection cannot represent is not projectable, and this is the only
    // assertion that says so.
    const rootSchema = new Schema({
      topNode: 'article',
      nodes: {
        article: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
      marks: {},
    });
    const doc = rootSchema.node('article', null, [rootSchema.node('paragraph')]);
    expect(() => pmDocToHtml(doc)).toThrow(UnknownNodeError);
    expect(() => pmDocToHtml(doc)).toThrow(/article/u);
    expect(() => pmDocToMarkdown(doc)).toThrow(UnknownNodeError);
  });

  it('throws on an unknown INLINE node, not only an unknown block', () => {
    // A separate code path: the text projection walks blocks and inline
    // content through different functions, so a block-level guard says nothing
    // about an unrecognised inline node sitting inside a known paragraph.
    const inlineSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        mystery: { group: 'inline', inline: true, atom: true },
        text: { group: 'inline' },
      },
      marks: {},
    });
    const doc = inlineSchema.node('doc', null, [
      inlineSchema.node('paragraph', null, [inlineSchema.node('mystery')]),
    ]);
    expect(() => pmDocToText(doc)).toThrow(UnknownNodeError);
    expect(() => pmDocToHtml(doc)).toThrow(UnknownNodeError);
    expect(() => pmDocToMarkdown(doc)).toThrow(UnknownNodeError);
    expect(() => pmDocToBlocks(doc)).toThrow(UnknownNodeError);
  });

  it('throws on a mark the frozen schema does not describe', () => {
    const markedSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
      marks: { mystery: {} },
    });
    const doc = markedSchema.node('doc', null, [
      markedSchema.node('paragraph', null, [
        markedSchema.text('t', [markedSchema.mark('mystery')]),
      ]),
    ]);
    expect(() => pmDocToHtml(doc)).toThrow(UnknownNodeError);
    expect(() => pmDocToMarkdown(doc)).toThrow(UnknownNodeError);
  });
});
