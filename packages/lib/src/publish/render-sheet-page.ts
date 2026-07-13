import { escapeHtml } from '../utils/html';
import { evaluateSheet, parseSheetContent } from '../sheets/sheet';
import { renderDocumentShell, wrapDocumentBody } from './document-shell';

export interface RenderSheetPageInput {
  serializedContent: unknown;
  title: string;
  lang?: string;
  /** Render the first row as `<th>` column headers instead of data. */
  hasHeaders?: boolean;
}

const EMPTY_STATE_HTML = '<p>This sheet is empty.</p>';

/**
 * Build the static `<table>` markup for a sheet, or an empty-state message
 * when the sheet has no cells (either genuinely blank, or `serializedContent`
 * failed to parse — `parseSheetContent` never throws and falls back to an
 * empty sheet for unparseable input, so the two cases are indistinguishable
 * at this layer and are handled identically). Formula cells render their
 * evaluated display value via `evaluateSheet`, the same evaluation the sheet
 * editor itself uses — no formula engine is reimplemented here.
 */
function buildSheetTableHtml(serializedContent: unknown, hasHeaders?: boolean): string {
  try {
    const sheet = parseSheetContent(serializedContent);
    if (Object.keys(sheet.cells).length === 0) {
      return EMPTY_STATE_HTML;
    }

    const { display } = evaluateSheet(sheet);
    const headerRow = hasHeaders ? display[0] : null;
    const bodyRows = hasHeaders ? display.slice(1) : display;
    const theadHtml = headerRow
      ? `<thead><tr>${headerRow.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`
      : '';
    const tbodyHtml = `<tbody>${bodyRows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;

    return `<table>${theadHtml}${tbodyHtml}</table>`;
  } catch {
    return EMPTY_STATE_HTML;
  }
}

/**
 * Render a SHEET page as a static, standalone HTML document: a plain
 * `<table>` snapshot of the sheet's evaluated cell values. No client-side
 * grid, no editing — head assembly and CSP (`script-src 'none'`) are
 * delegated to `document-shell.ts`, the same shell path DOCUMENT pages use.
 */
export function renderSheetPage({ serializedContent, title, lang, hasHeaders }: RenderSheetPageInput): string {
  const bodyHtml = wrapDocumentBody({
    bodyHtml: buildSheetTableHtml(serializedContent, hasHeaders),
    title,
  });
  return renderDocumentShell({ title, bodyHtml, lang });
}
