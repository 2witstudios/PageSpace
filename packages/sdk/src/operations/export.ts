/**
 * Export operations (Phase 3 task 10 — old handler `export.js`). The old
 * handler only ever wrapped `get_page_details` (now `pages.details`, Phase 3
 * task 2) — no MCP tool ever exposed `PageSpaceApi.requestText` (old repo
 * `src/api.js:47`), leaving it dead code (Phase 0 inventory: "no export
 * tools are registered"). These two live, previously-untooled routes are the
 * actual text-export surface `requestText` was built for:
 * `apps/web/src/app/api/pages/[pageId]/export/markdown/route.ts` GET and
 * `.../export/csv/route.ts` GET. The sibling `xlsx`/`docx` routes under the
 * same directory return binary
 * (`application/vnd.openxmlformats-officedocument...`) bodies, not text —
 * out of scope for this textResponse-based domain.
 *
 * Both routes return the exported body verbatim with no JSON envelope on
 * success; `parseResponse`'s `textResponse` passthrough applies, gated by
 * `expectedContentType` (Phase 2 task 3 extension, this task) so a
 * misrouted/proxied non-text response — e.g. a JSON error page or an HTML
 * error page served with a 2xx by a broken proxy — surfaces as a typed
 * `ResponseValidationError` instead of being handed to the caller as if it
 * were markdown/CSV.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const exportPageInputSchema = z.object({ pageId: z.string() });

// ---------------------------------------------------------------------------
// export.pageMarkdown — GET /api/pages/:pageId/export/markdown
// ---------------------------------------------------------------------------

export const exportPageMarkdown = defineOperation({
  name: 'export.pageMarkdown',
  method: 'GET',
  path: '/api/pages/:pageId/export/markdown',
  inputSchema: exportPageInputSchema,
  outputSchema: z.string(),
  textResponse: true,
  expectedContentType: 'text/markdown',
  requiredScope: 'drive',
  // Turndown conversion of a large HTML document can run well past the
  // client's default 30s (route: markdown/route.ts:59-62).
  timeoutMsOverride: 60_000,
  description:
    'Export a DOCUMENT page as Markdown. Route requires page.type === "DOCUMENT" (400 otherwise: "Markdown export is only available for DOCUMENT pages"); markdown-mode pages are returned as-is, HTML-mode pages are converted via Turndown. Response body is the raw Markdown text (Content-Type: text/markdown).',
});

// ---------------------------------------------------------------------------
// export.sheetCsv — GET /api/pages/:pageId/export/csv
// ---------------------------------------------------------------------------

export const exportSheetCsv = defineOperation({
  name: 'export.sheetCsv',
  method: 'GET',
  path: '/api/pages/:pageId/export/csv',
  inputSchema: exportPageInputSchema,
  outputSchema: z.string(),
  textResponse: true,
  expectedContentType: 'text/csv',
  requiredScope: 'drive',
  // Sheet parsing + full formula re-evaluation before serialization
  // (route: csv/route.ts:57-64) can run well past the client's default 30s
  // on a large sheet.
  timeoutMsOverride: 60_000,
  description:
    'Export a SHEET page as CSV. Route requires page.type === "SHEET" (400 otherwise: "CSV export is only available for SHEET pages"); the sheet is parsed, formulas evaluated, and the display values serialized to CSV. Response body is the raw CSV text (Content-Type: text/csv).',
});
