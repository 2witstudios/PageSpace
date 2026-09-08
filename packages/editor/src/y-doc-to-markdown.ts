import {
  MarkdownSerializer,
  type MarkdownSerializerState,
} from 'prosemirror-markdown';
import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { yDocToPmDoc } from './collab-document.js';
import { UnknownNodeError } from './projection-errors.js';

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
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const fileId = typeof node.attrs.fileId === 'string' ? node.attrs.fileId : '';
  state.write(`![${state.esc(alt)}](pagespace-file:${fileId.replace(/[()]/gu, '\\$&')})`);
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

const ALIGNMENT_DELIMITERS: Readonly<Record<string, string>> = {
  left: ':---',
  center: ':---:',
  right: '---:',
};

function alignmentDelimiter(cell: PmNode | undefined): string {
  const align = cell?.attrs.align;
  return (typeof align === 'string' && ALIGNMENT_DELIMITERS[align]) || '---';
}

function tableMarkdown(state: MarkdownSerializerState, node: PmNode): void {
  const rows: PmNode[] = [];
  node.forEach((row) => rows.push(row));

  const cellsOf = (row: PmNode): PmNode[] => {
    const cells: PmNode[] = [];
    row.forEach((cell) => cells.push(cell));
    return cells;
  };

  const columnCount = rows.reduce((max, row) => Math.max(max, row.childCount), 0);
  const pad = (cells: string[]): string[] =>
    Array.from({ length: columnCount }, (_unused, index) => cells[index] ?? '');

  // GFM has no table without a header row. When the first row is not one (a
  // table of plain cells is perfectly legal in the schema), an empty header is
  // emitted rather than promoting a data row — promoting one would silently
  // change what the table says.
  const firstRow = rows[0];
  const firstIsHeader =
    firstRow !== undefined &&
    firstRow.childCount > 0 &&
    cellsOf(firstRow).every((cell) => cell.type.name === 'tableHeader');

  const headerCells = firstIsHeader ? cellsOf(firstRow).map(cellMarkdown) : [];
  const bodyRows = (firstIsHeader ? rows.slice(1) : rows).map((row) =>
    cellsOf(row).map(cellMarkdown),
  );
  const alignmentSource = cellsOf(firstRow ?? node);

  const lines = [
    `| ${pad(headerCells).join(' | ')} |`,
    `| ${pad([])
      .map((_unused, index) => alignmentDelimiter(alignmentSource[index]))
      .join(' | ')} |`,
    ...bodyRows.map((cells) => `| ${pad(cells).join(' | ')} |`),
  ];

  state.write(lines.join('\n'));
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
        const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
        state.write(`${fence}${language}\n`);
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
        const label = node.attrs.label;
        if (typeof label === 'string' && label.length > 0) {
          state.text(`@${label}`);
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
          const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
          return `](${href.replace(/[()"]/gu, '\\$&')})`;
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
 * `MarkdownSerializer` throws its own `RangeError` for an unregistered node,
 * but the message ("Token type `x` not supported by Markdown renderer") reads
 * as a renderer gap rather than as this package's fail-closed contract, and it
 * carries no projection name. Rethrowing as `UnknownNodeError` keeps a single
 * error type across all four projections, which is what a caller catches on.
 */
function assertMarkdownProjectable(doc: PmNode): void {
  const serializer = markdownSerializer();
  const knownNodes = new Set(Object.keys(serializer.nodes));
  const knownMarks = new Set(Object.keys(serializer.marks));
  doc.descendants((node) => {
    if (!knownNodes.has(node.type.name)) {
      throw new UnknownNodeError(node.type.name, 'markdown');
    }
    for (const mark of node.marks) {
      if (!knownMarks.has(mark.type.name)) {
        throw new UnknownNodeError(mark.type.name, 'markdown');
      }
    }
    return true;
  });
}
