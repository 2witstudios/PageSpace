/**
 * Compose pdf.js text items back into text that keeps its lines.
 *
 * A PDF has no notion of a line of text — it positions runs of glyphs. pdf.js
 * hands those runs back as items, one per run, and the extractor used to join
 * every item on a page with a single space. That produced one enormous
 * paragraph per page: a resume's every heading, bullet and table row ran
 * together, and `pages read` reported a two-page document as three lines.
 *
 * Two signals say where a line ended, and both are used on every page:
 *
 *  - `hasEOL`, which pdf.js sets on the item that ends a visual line.
 *  - the item's baseline Y (`transform[5]`) dropping below the baseline of the
 *    line being built.
 *
 * They are combined rather than selected between. A page can be annotated only
 * in places — pdf.js marks the line ends it recognises, not necessarily all of
 * them — so treating one marker as proof the whole page is annotated would
 * re-flatten every unmarked line on a mixed-content page.
 *
 * The geometry half only ever breaks on DOWNWARD movement, measured against
 * the baseline of the current line rather than the previous run, and only past
 * a tolerance scaled to the glyph height. A superscript rises above the
 * baseline and a subscript dips a fraction of an em below it, so neither can
 * split a line the producer never broke — while real line spacing (~1.2em)
 * clears the tolerance easily.
 */

/** The subset of a pdf.js `TextItem` this module reads. */
export interface PdfTextItem {
  str: string;
  /** pdf.js sets this on the item that ends a visual line. */
  hasEOL?: boolean;
  /** pdf.js text-item matrix; index 5 is the baseline Y in PDF units. */
  transform?: number[];
  /** Glyph height of the run, in the same units as the baseline. */
  height?: number;
}

/**
 * Floor for the downward baseline movement (PDF units, 1/72") that starts a new
 * line, used when a run reports no height. Body text sets its lines ~12 units
 * apart, so 2 separates lines without breaking on float noise along one
 * baseline.
 */
const Y_TOLERANCE_FLOOR = 2;

/**
 * Fraction of the glyph height a baseline must drop to count as a new line. A
 * subscript sits roughly 0.2-0.3em below the baseline and a line of text sits
 * ~1.2em below the one above it, so half the glyph height separates the two
 * with room on either side.
 */
const Y_TOLERANCE_HEIGHT_RATIO = 0.5;

function itemY(item: PdfTextItem): number | undefined {
  return item.transform?.[5];
}

/** Collapse the runs of spaces PDF word-positioning produces, and trim. */
function tidy(line: string): string {
  return line.replace(/[ \t]+/g, ' ').trim();
}

/** One page of pdf.js items → text with its line breaks intact. */
export function composePageText(items: readonly PdfTextItem[]): string {
  const lines: string[] = [];
  let current: string[] = [];
  // Baseline and glyph height of the line being built — NOT of the previous
  // run, so an inline baseline shift cannot be mistaken for a line break.
  let lineY: number | undefined;
  let lineHeight: number | undefined;

  // Both signals can fire for the same break — pdf.js often ends a line with
  // an empty item that carries the NEXT line's baseline, so the geometry check
  // flushes and the EOL marker on that same item would flush again. A flush
  // with nothing buffered emits nothing rather than a blank line.
  const flush = () => {
    const line = tidy(current.join(' '));
    current = [];
    lineY = undefined;
    lineHeight = undefined;
    if (line === '') return;
    lines.push(line);
  };

  for (const item of items) {
    const y = itemY(item);

    if (current.length > 0 && y !== undefined && lineY !== undefined
        && lineY - y > lineTolerance(lineHeight)) {
      flush();
    }

    if (item.str !== '') current.push(item.str);
    if (y !== undefined && lineY === undefined) {
      lineY = y;
      lineHeight = item.height;
    }

    if (item.hasEOL === true) flush();
  }
  if (current.length > 0) flush();

  return lines.join('\n');
}

/** How far a baseline must drop, below a line of this glyph height, to break. */
function lineTolerance(height: number | undefined): number {
  if (height === undefined) return Y_TOLERANCE_FLOOR;
  return Math.max(Y_TOLERANCE_FLOOR, height * Y_TOLERANCE_HEIGHT_RATIO);
}

/** Page texts → the document body. A page break is a blank line. */
export function composeDocumentText(pages: readonly string[]): string {
  return pages.join('\n\n');
}
