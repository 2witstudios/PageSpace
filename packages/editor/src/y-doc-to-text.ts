import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { yDocToPmDoc } from './collab-document.js';
import { mentionLabelText } from './page-mention-node.js';
import { UnknownNodeError } from './projection-errors.js';

/**
 * The plain-text projection: the document's prose, and nothing else.
 *
 * This projection exists to fix a live defect. `apps/web/src/app/api/search/
 * route.ts` `ILIKE`s `pages.content`, which is raw HTML — so searching for
 * `span`, `href`, `style` or `table` matches *markup*, and a document that
 * merely contains a styled span is returned as a hit for "span". The output
 * here contains no tag name, no attribute name and no attribute value, which
 * is why the test for this asserts that a document full of `<span style>` and
 * `<a href>` does not match a search for `span` or `href`.
 *
 * Marks are ignored entirely — a mark is formatting, and formatting is exactly
 * what must not appear. Only nodes that carry *text* contribute; `image` and
 * `horizontalRule` contribute nothing, deliberately: `alt` is an accessibility
 * annotation rather than document prose, and putting it in the search corpus
 * would let a decorative image's alt text answer a prose query.
 *
 * Blocks are separated by `\n` so a phrase can never be formed by two
 * paragraphs abutting — the failure mode that makes `Element.textContent` the
 * wrong tool here. Table cells are separated by tabs within their row.
 *
 * NOT the same thing as `projectContent`
 * (`packages/lib/src/content/anchoring/text-projection.ts`), which looks
 * similar and is not interchangeable: that one collapses whitespace and trims
 * because it defines an ANCHOR COORDINATE SYSTEM that tag offsets are stored
 * against. This one keeps text verbatim, tab-joins table cells and throws on an
 * unknown node. Do not wire anchors to this projection.
 */
export function yDocToText(yDoc: Y.Doc): string {
  return pmDocToText(yDocToPmDoc(yDoc));
}

/** `yDocToText` over an already-materialised ProseMirror document. */
export function pmDocToText(doc: PmNode): string {
  return flatten(doc, '\n');
}

/**
 * The projection's core join rule, in one place: collect the node's lines, drop
 * the empty ones, join. Only the separator differs between a document (`\n`,
 * block boundaries) and a table cell (`' '`, which cannot contain a newline).
 */
function flatten(node: PmNode, separator: string): string {
  const lines: string[] = [];
  collectLines(node, lines);
  return lines.filter((line) => line.length > 0).join(separator);
}

function inlineText(node: PmNode): string {
  switch (node.type.name) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'pageMention':
      // Shared with the markdown projection, which must render mentions
      // identically — see `mentionLabelText`.
      return mentionLabelText(node);
    default:
      throw new UnknownNodeError(node.type.name, 'text');
  }
}

function inlineChildren(node: PmNode): string {
  let text = '';
  node.forEach((child) => {
    text += inlineText(child);
  });
  return text;
}

/** A table cell's blocks flattened onto one line, so a row stays a row. */
function cellText(cell: PmNode): string {
  return flatten(cell, ' ');
}

function collectLines(node: PmNode, lines: string[]): void {
  switch (node.type.name) {
    // Pure containers: recurse, contribute nothing of their own. `table` is
    // here too — its rows are what carry structure, and `tableRow` below is
    // where a row becomes a line.
    case 'doc':
    case 'blockquote':
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'taskList':
    case 'taskItem':
    case 'table':
    case 'tableCell':
    case 'tableHeader':
      node.forEach((child) => collectLines(child, lines));
      return;

    case 'paragraph':
    case 'heading':
      lines.push(inlineChildren(node));
      return;

    case 'codeBlock':
      // `codeBlock`'s content is `text*` with `whitespace: 'pre'`, so its own
      // newlines are real and must survive as line breaks rather than being
      // flattened into one line.
      lines.push(...inlineChildren(node).split('\n'));
      return;

    case 'tableRow': {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cellText(cell)));
      lines.push(cells.join('\t'));
      return;
    }

    // Content-bearing but textless: they contribute a document position, not
    // prose. Emitting a blank line for them would insert phantom block
    // boundaries into the corpus.
    case 'image':
    case 'horizontalRule':
      return;

    default:
      throw new UnknownNodeError(node.type.name, 'text');
  }
}
