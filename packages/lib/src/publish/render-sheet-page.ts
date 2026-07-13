import { renderCanvasDocument } from '../canvas/render-document';
import { buildDocumentCsp } from '../canvas/csp';
import { escapeHtml } from '../utils/html';
import { evaluateSheet, parseSheetContent } from '../sheets/sheet';
import { wrapDocumentBody, DOCUMENT_TYPOGRAPHY_CSS } from './document-shell';

export interface RenderSheetPageInput {
  serializedContent: unknown;
  title: string;
  /** Render the first row as `<th>` column headers instead of data. */
  hasHeaders?: boolean;
  pageUrl?: string;
  ogImageUrl?: string;
  ogDescription?: string;
  description?: string;
  robots?: string;
  faviconHref?: string;
  faviconBaseUrl?: string;
  lang?: string;
  allowedAssetHosts?: string[];
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
 * Render a SHEET page as a complete, standalone HTML document: a plain
 * `<table>` snapshot of the sheet's evaluated cell values. No client-side
 * grid, no editing.
 *
 * Mirrors `render-document-page.ts`: reuses the canvas renderer's whole head
 * assembly (SEO/OG/Twitter/JSON-LD, favicon, CSP `<meta>`) via
 * `cspOverride`/`injectThemeBridge: false` rather than duplicating it — SHEET
 * pages never run author scripts, so they get `buildDocumentCsp()`
 * (`script-src 'none'`) and no theme-bridge script.
 */
export function renderSheetPage(input: RenderSheetPageInput): string {
  const { serializedContent, title, hasHeaders, pageUrl, ogImageUrl, ogDescription, description, robots, faviconHref, faviconBaseUrl, lang, allowedAssetHosts } = input;

  const wrappedBody = wrapDocumentBody({
    bodyHtml: buildSheetTableHtml(serializedContent, hasHeaders),
    title,
  });

  return renderCanvasDocument({
    html: `<style>${DOCUMENT_TYPOGRAPHY_CSS}</style>${wrappedBody}`,
    title,
    pageUrl,
    ogImageUrl,
    ogDescription,
    description,
    robots,
    faviconHref,
    faviconBaseUrl,
    lang,
    allowedAssetHosts,
    cspOverride: buildDocumentCsp(),
    injectThemeBridge: false,
  });
}
