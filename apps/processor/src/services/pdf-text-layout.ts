/**
 * Compose pdf.js text items back into text that keeps its lines.
 *
 * A PDF has no notion of a line of text — it positions runs of glyphs. pdf.js
 * hands those runs back as items, one per run, and the extractor used to join
 * every item on a page with a single space. That produced one enormous
 * paragraph per page: a resume's every heading, bullet and table row ran
 * together, and `pages read` reported a two-page document as three lines.
 *
 * pdf.js marks the end of a visual line on the item that ends it (`hasEOL`),
 * and where it doesn't, the item's Y coordinate (`transform[5]`) still moves
 * between lines. Prefer the explicit marker and fall back to geometry, but
 * never both at once: a superscript shifts the baseline a few units without
 * starting a new line, so honouring Y on a document that already reports EOL
 * would split lines the producer never broke.
 */

/** The subset of a pdf.js `TextItem` this module reads. */
export interface PdfTextItem {
  str: string;
  /** pdf.js sets this on the item that ends a visual line. */
  hasEOL?: boolean;
  /** pdf.js text-item matrix; index 5 is the baseline Y in PDF units. */
  transform?: number[];
}

/**
 * Baseline movement (PDF units, 1/72") that counts as a new line when no item
 * on the page reports `hasEOL`. Line spacing for body text is ~12 units, so 2
 * separates lines without breaking on float noise along one baseline.
 */
const Y_TOLERANCE = 2;

function itemY(item: PdfTextItem): number | undefined {
  return item.transform?.[5];
}

/** Collapse the runs of spaces PDF word-positioning produces, and trim. */
function tidy(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Drop leading and trailing blank lines and collapse any run of blank lines to
 * a single one — vertical whitespace in a PDF is a paragraph break, not N of
 * them.
 */
function squeezeBlankLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** One page of pdf.js items → text with its line breaks intact. */
export function composePageText(items: readonly PdfTextItem[]): string {
  const usesEol = items.some((item) => item.hasEOL === true);

  const lines: string[] = [];
  let current: string[] = [];
  let prevY: number | undefined;

  const flush = () => {
    lines.push(tidy(current.join(' ')));
    current = [];
  };

  for (const item of items) {
    const y = itemY(item);

    if (!usesEol && current.length > 0 && y !== undefined && prevY !== undefined
        && Math.abs(y - prevY) > Y_TOLERANCE) {
      flush();
    }

    if (item.str !== '') current.push(item.str);
    if (y !== undefined) prevY = y;

    // No `usesEol` guard needed: when it is false, no item reports hasEOL at
    // all, and the Y branch above is the only thing breaking lines.
    if (item.hasEOL === true) flush();
  }
  if (current.length > 0) flush();

  return squeezeBlankLines(lines).join('\n');
}

/** Page texts → the document body. A page break is a blank line. */
export function composeDocumentText(pages: readonly string[]): string {
  return pages.join('\n\n');
}
