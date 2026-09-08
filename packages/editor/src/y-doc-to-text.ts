import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { yDocToPmDoc } from './collab-document.js';
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
 */
export function yDocToText(yDoc: Y.Doc): string {
  return pmDocToText(yDocToPmDoc(yDoc));
}

/** `yDocToText` over an already-materialised ProseMirror document. */
export function pmDocToText(doc: PmNode): string {
  const lines: string[] = [];
  collectLines(doc, lines);
  return lines.filter((line) => line.length > 0).join('\n');
}

/**
 * `@label`, matching what a reader sees. A mention with no label contributes
 * nothing rather than a bare `@`: the id is a CUID, and putting CUIDs in the
 * search corpus means a query of the right shape matches documents that
 * merely link to a page.
 */
function mentionText(node: PmNode): string {
  const label = node.attrs.label;
  return typeof label === 'string' && label.length > 0 ? `@${label}` : '';
}

function inlineText(node: PmNode): string {
  switch (node.type.name) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'pageMention':
      return mentionText(node);
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
  const lines: string[] = [];
  collectLines(cell, lines);
  return lines.filter((line) => line.length > 0).join(' ');
}

function collectLines(node: PmNode, lines: string[]): void {
  switch (node.type.name) {
    case 'doc':
    case 'blockquote':
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'taskList':
    case 'taskItem':
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

    case 'table':
      node.forEach((row) => collectLines(row, lines));
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
