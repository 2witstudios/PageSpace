import type { DomElement } from './constructs';

/**
 * How big the biggest single thing in a document is.
 *
 * Every other tally in this census is presence per page — the question "would
 * v1 lose this construct" only ever needed a yes. Pagination asks a different
 * question and needs a size.
 *
 * `PaginationExtension.ts` is decoration-based: it measures the rendered height
 * of each block and inserts page breaks BETWEEN blocks. Nothing splits a block.
 * So a table taller than `--rm-max-content-child-height`, a 400-line code fence
 * or a wall-of-text paragraph cannot be paginated at all — they overflow their
 * page, and the count of pages that already contain one is the precondition for
 * ever flipping `isPaginated` on.
 *
 * Images are about to join that list, which is why they are counted here as
 * well as classified in `images.ts`: an image is the one block whose height is
 * unknown until it loads, so a decoration-based paginator measures the page
 * wrong and then re-measures when the byte arrives. That is the argument for
 * intrinsic width/height on the node at insert time, and the count of images
 * per document is the argument's magnitude.
 *
 * Lengths only. Nothing here returns the text it measured.
 */
export const MAGNITUDE_METRICS = [
  { key: 'images', label: 'images in one document' },
  { key: 'tableRows', label: 'rows in one table' },
  { key: 'tableColumns', label: 'columns in one table' },
  { key: 'codeBlockLines', label: 'lines in one code block' },
  { key: 'blockCharacters', label: 'characters in one block' },
] as const;

export type MagnitudeKey = (typeof MAGNITUDE_METRICS)[number]['key'];
export type Magnitudes = Record<MagnitudeKey, number>;

export function emptyMagnitudes(): Magnitudes {
  return { images: 0, tableRows: 0, tableColumns: 0, codeBlockLines: 0, blockCharacters: 0 };
}

/**
 * Elements the editor renders as a block, and therefore the units the
 * paginator has to fit whole onto a page. `li`/`td` are included because a list
 * item holding a nested list, or a cell holding a paragraph, is as tall as
 * everything inside it — which is exactly what the layout has to place.
 */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, td, th';

export function lineCount(text: string): number {
  let lines = 1;
  for (const character of text) {
    if (character === '\n') lines += 1;
  }
  return lines;
}

export function htmlMagnitudes(container: DomElement): Magnitudes {
  const magnitudes = emptyMagnitudes();

  for (const _image of container.querySelectorAll('img')) {
    magnitudes.images += 1;
  }

  for (const table of container.querySelectorAll('table')) {
    let rows = 0;
    for (const row of table.querySelectorAll('tr')) {
      rows += 1;
      let columns = 0;
      for (const _cell of row.querySelectorAll('td, th')) {
        columns += 1;
      }
      magnitudes.tableColumns = Math.max(magnitudes.tableColumns, columns);
    }
    magnitudes.tableRows = Math.max(magnitudes.tableRows, rows);
  }

  for (const block of container.querySelectorAll(BLOCK_SELECTOR)) {
    const text = block.textContent ?? '';
    magnitudes.blockCharacters = Math.max(magnitudes.blockCharacters, text.length);
    if (block.tagName.toLowerCase() === 'pre') {
      magnitudes.codeBlockLines = Math.max(magnitudes.codeBlockLines, lineCount(text));
    }
  }

  return magnitudes;
}

/**
 * Fold one document's measurements into another's. Images SUM because they are
 * a count of things on the page; everything else is a maximum, because the
 * question is whether any single block fits.
 *
 * Used where markdown source embeds raw HTML: the two halves of one document
 * are measured by two different readers and have to come out as one document.
 */
export function absorb(into: Magnitudes, from: Magnitudes): void {
  into.images += from.images;
  into.tableRows = Math.max(into.tableRows, from.tableRows);
  into.tableColumns = Math.max(into.tableColumns, from.tableColumns);
  into.codeBlockLines = Math.max(into.codeBlockLines, from.codeBlockLines);
  into.blockCharacters = Math.max(into.blockCharacters, from.blockCharacters);
}
