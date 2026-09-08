import {
  MarkdownSerializer,
  type MarkdownSerializerState,
} from 'prosemirror-markdown';
import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { collabSchema, yDocToPmDoc } from './collab-document.js';
import { mentionLabelText } from './page-mention-node.js';
import { stringAttr } from './pm-attrs.js';
import { assertProjectable } from './projection-errors.js';

/**
 * The markdown projection — the AI-context format.
 *
 * Two things it is NOT:
 *
 * 1. **Not `tiptap-markdown`.** That package's serializer needs a live
 *    `Editor` instance (`tiptap-markdown.es.js:744-796` reads
 *    `this.editor.extensionManager` and `this.editor.schema`), which a
 *    headless Node service does not have and must not be made to fake. This is
 *    written on `prosemirror-markdown` directly, over the frozen schema's own
 *    node and mark names.
 * 2. **Not a round-trip format.** It is one-way, and deliberately so: it
 *    exists because HTML costs materially more tokens per document than
 *    markdown and models comprehend markdown better. `pages.content` (HTML)
 *    remains the lossless projection; anything this one cannot express is
 *    still there.
 *
 * What it cannot express, stated rather than hidden — each of these preserves
 * the *text* and drops only an annotation:
 *
 * - `underline`, `highlight` and `textStyle` (font, size, colour) have no
 *   markdown form and pass through transparently.
 * - `comment`, `insertion` and `deletion` are inert v1 marks with no markdown
 *   form; likewise transparent.
 * - `pageMention` renders as its visible `@label`. The mention *graph* —
 *   which page or user it points at — lives in the HTML projection, which is
 *   what `syncMentions` reads. A consumer that rewrites a block through this
 *   projection therefore cannot preserve mention identity, and the block tools
 *   must carry ids out of band rather than expecting them here.
 * - `colspan`/`rowspan` have no GFM equivalent; a merged cell's text survives,
 *   its span does not.
 *
 * Everything else — headings 1-6, both list kinds with their `tight` flag,
 * task lists with checked state, code blocks with their `language`, tables
 * with column alignment, images with `alt` and `fileId`, links, bold, italic,
 * strike and inline code — is represented.
 */
export function yDocToMarkdown(yDoc: Y.Doc): string {
  return pmDocToMarkdown(yDocToPmDoc(yDoc));
}

/** `yDocToMarkdown` over an already-materialised ProseMirror document. */
export function pmDocToMarkdown(doc: PmNode): string {
  assertMarkdownProjectable(doc);
  return markdownSerializer().serialize(doc, { tightLists: true });
}

/**
 * `![alt](pagespace-file:<fileId>)`.
 *
 * The v1 `image` node holds a FILE REFERENCE and never a URL (see
 * `image-node.ts` for why: a signed URL written into a CRDT is permanent,
 * expiring and credential-bearing at once). There is no URL to put in the
 * parentheses, so this emits the reference under an explicit non-resolvable
 * scheme rather than fabricating one. `prosemirror-markdown`'s own default
 * `image` serializer reads `node.attrs.src` and would throw here.
 */
function imageMarkdown(state: MarkdownSerializerState, node: PmNode): void {
  const fileId = stringAttr(node.attrs, 'fileId');
  state.write(
    `![${state.esc(stringAttr(node.attrs, 'alt'))}](pagespace-file:${fileId.replace(/[()]/gu, '\\$&')})`,
  );
}

/**
 * One GFM cell: its blocks flattened onto a single line, because a pipe table
 * row cannot contain a newline. Pipes are escaped so a cell containing `|`
 * cannot forge a column boundary — the one way a table's *structure* could be
 * corrupted rather than merely simplified.
 */
function cellMarkdown(cell: PmNode): string {
  return markdownSerializer()
    .serialize(cell, { tightLists: true })
    .replace(/\|/gu, '\\|')
    .replace(/\s*\n\s*/gu, ' ')
    .trim();
}

/**
 * A `Map`, NOT an object literal, and that is load-bearing rather than
 * stylistic.
 *
 * `align` is read from a node attribute, and node attributes on a live document
 * come from whatever a CLIENT wrote into the Y.Doc — the schema declares no
 * validator for this one, so any string reaches here. Indexing an object
 * literal with that string resolves through `Object.prototype`:
 * `align="toString"` returned the function, and `?? '---'` never fired because
 * a function is not nullish. The projection then emitted
 * `| function toString() {` into the delimiter row — a function's source, with
 * its own newlines, injected into the AI-context projection and destroying the
 * table's structure.
 *
 * TipTap's own HTML parser whitelists `align`, so this is unreachable from
 * stored `pages.content`. It is entirely reachable from the CRDT, which is the
 * path this package exists to serve.
 */
const ALIGNMENT_DELIMITERS: ReadonlyMap<string, string> = new Map([
  ['left', ':---'],
  ['center', ':---:'],
  ['right', '---:'],
]);

/** A node's children as an array — ProseMirror only offers `forEach`. */
function childrenOf(node: PmNode): PmNode[] {
  const children: PmNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function alignmentDelimiter(cell: PmNode | undefined): string {
  if (cell === undefined) {
    return '---';
  }
  return ALIGNMENT_DELIMITERS.get(stringAttr(cell.attrs, 'align')) ?? '---';
}

function tableMarkdown(state: MarkdownSerializerState, node: PmNode): void {
  const rows = childrenOf(node);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.childCount), 0);

  // Every row is padded to the widest row's width, so a short row cannot shift
  // the columns after it — one rule, applied by one function, to all three
  // kinds of line below.
  const line = (cell: (index: number) => string): string =>
    `| ${Array.from({ length: columnCount }, (_unused, index) => cell(index)).join(' | ')} |`;

  // GFM has no table without a header row. When the first row is not one (a
  // table of plain cells is perfectly legal in the schema), an empty header is
  // emitted rather than promoting a data row — promoting one would silently
  // change what the table says.
  const firstCells = rows.length > 0 ? childrenOf(rows[0]) : [];
  const firstIsHeader =
    firstCells.length > 0 && firstCells.every((cell) => cell.type.name === 'tableHeader');

  const headerCells = firstIsHeader ? firstCells.map(cellMarkdown) : [];
  const bodyRows = (firstIsHeader ? rows.slice(1) : rows).map((row) =>
    childrenOf(row).map(cellMarkdown),
  );

  state.write(
    [
      line((index) => headerCells[index] ?? ''),
      line((index) => alignmentDelimiter(firstCells[index])),
      ...bodyRows.map((cells) => line((index) => cells[index] ?? '')),
    ].join('\n'),
  );
  state.closeBlock(node);
}

let cachedSerializer: MarkdownSerializer | undefined;

/**
 * Lazily built and memoised — `tableMarkdown` and `cellMarkdown` recurse back
 * into the serializer to render a cell's own blocks, so it cannot be a plain
 * module-level `const` without a temporal-dead-zone reference to itself.
 */
function markdownSerializer(): MarkdownSerializer {
  cachedSerializer ??= new MarkdownSerializer(
    {
      paragraph(state, node) {
        state.renderInline(node);
        state.closeBlock(node);
      },

      heading(state, node) {
        state.write(`${state.repeat('#', Number(node.attrs.level) || 1)} `);
        state.renderInline(node, false);
        state.closeBlock(node);
      },

      blockquote(state, node) {
        state.wrapBlock('> ', null, node, () => state.renderContent(node));
      },

      codeBlock(state, node) {
        // The fence must be longer than the longest backtick run inside the
        // block, or the block terminates early and the rest of the document
        // is swallowed into it.
        const runs = node.textContent.match(/`{3,}/gmu);
        const fence = runs ? `${runs.sort().slice(-1)[0]}\`` : '```';
        state.write(`${fence}${stringAttr(node.attrs, 'language')}\n`);
        state.text(node.textContent, false);
        state.write('\n');
        state.write(fence);
        state.closeBlock(node);
      },

      horizontalRule(state, node) {
        state.write('---');
        state.closeBlock(node);
      },

      bulletList(state, node) {
        state.renderList(node, '  ', () => '- ');
      },

      orderedList(state, node) {
        const start = Number(node.attrs.start) || 1;
        const width = String(start + node.childCount - 1).length;
        state.renderList(node, state.repeat(' ', width + 2), (index) => {
          const label = String(start + index);
          return `${state.repeat(' ', width - label.length)}${label}. `;
        });
      },

      listItem(state, node) {
        state.renderContent(node);
      },

      taskList(state, node) {
        state.renderList(node, '  ', (index) =>
          node.child(index).attrs.checked === true ? '- [x] ' : '- [ ] ',
        );
      },

      taskItem(state, node) {
        state.renderContent(node);
      },

      table: tableMarkdown,

      // A whole table is rendered by `table` above, which builds its pipe
      // markup itself and never renders rows through the state — so these
      // three are not on that path. They are still REQUIRED: they are what
      // `assertMarkdownProjectable` checks a table's rows and cells against,
      // and without them every document containing a table would be refused
      // as unprojectable. They also make serializing a bare table fragment
      // (a row, a cell) produce its content rather than throw.
      tableRow(state, node) {
        state.renderContent(node);
      },
      tableCell(state, node) {
        state.renderContent(node);
      },
      tableHeader(state, node) {
        state.renderContent(node);
      },

      image: imageMarkdown,

      pageMention(state, node) {
        // Shared with the text projection — `projections.test.ts` asserts the
        // two agree, so the rule cannot live in both.
        const label = mentionLabelText(node);
        if (label.length > 0) {
          state.text(label);
        }
      },

      hardBreak(state, node, parent, index) {
        // A run of trailing hard breaks at the end of a block is caret
        // padding, not content — only emit one when real content follows.
        for (let i = index + 1; i < parent.childCount; i += 1) {
          if (parent.child(i).type !== node.type) {
            state.write('\\\n');
            return;
          }
        }
      },

      text(state, node) {
        state.text(node.text ?? '');
      },
    },
    {
      bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
      italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
      strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
      code: { open: '`', close: '`', escape: false },
      link: {
        open: '[',
        close(_state, mark) {
          return `](${stringAttr(mark.attrs, 'href').replace(/[()"]/gu, '\\$&')})`;
        },
      },

      // Transparent by design — see this module's docstring. `open`/`close`
      // of '' preserves the marked text and drops only the annotation.
      underline: { open: '', close: '', mixable: true },
      highlight: { open: '', close: '', mixable: true },
      textStyle: { open: '', close: '', mixable: true },
      comment: { open: '', close: '', mixable: true },
      insertion: { open: '', close: '', mixable: true },
      deletion: { open: '', close: '', mixable: true },
    },
  );
  return cachedSerializer;
}

/**
 * The names the markdown projection can represent.
 *
 * Deliberately NOT the schema's set: the serializer's node map has no `doc`
 * entry, because `MarkdownSerializer.serialize` renders the root's CHILDREN.
 * The root is still a node the guard must accept, so the schema's top node is
 * added back explicitly rather than the guard being taught to skip roots.
 *
 * Built once. `pmDocToBlocks` projects each block separately, so building these
 * per call meant 400 throwaway `Set`s on a 200-block document — measured at
 * ~40% of its runtime.
 */
let cachedNames: { nodes: ReadonlySet<string>; marks: ReadonlySet<string> } | undefined;

function projectableNames(): { nodes: ReadonlySet<string>; marks: ReadonlySet<string> } {
  const serializer = markdownSerializer();
  cachedNames ??= {
    nodes: new Set([...Object.keys(serializer.nodes), collabSchema().topNodeType.name]),
    marks: new Set(Object.keys(serializer.marks)),
  };
  return cachedNames;
}

/**
 * `MarkdownSerializer` throws its own `RangeError` for an unregistered node,
 * but the message ("Token type `x` not supported by Markdown renderer") reads
 * as a renderer gap rather than as this package's fail-closed contract, and it
 * carries no projection name. Checking up front keeps a single error type
 * across all four projections, which is what a caller catches on.
 */
function assertMarkdownProjectable(doc: PmNode): void {
  const known = projectableNames();
  assertProjectable(doc, 'markdown', known.nodes, known.marks);
}
