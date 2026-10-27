import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { isNotFoundError, isPermissionDeniedError, isResponseValidationError, isValidationError } from '../../errors.js';
import { exportPageMarkdown, exportSheetCsv } from '../export.js';

const config = { baseUrl: 'https://pagespace.ai' };

const markdownFixture = '# Project Notes\n\n- one\n- two\n\nSome **bold** text.\n';
const csvFixture = 'Header A,Header B\r\n1,2\r\n3,4\r\n';

describe('export.pageMarkdown — request shape', () => {
  it('builds a GET to /api/pages/:pageId/export/markdown with no body', () => {
    const request = buildRequest(exportPageMarkdown, { pageId: 'p1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1abc/export/markdown');
    expect(request.body).toBeUndefined();
  });

  it('rejects input missing pageId (path param required)', () => {
    const result = exportPageMarkdown.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('export.pageMarkdown — response contract (textResponse passthrough)', () => {
  it('passes the markdown body through verbatim on a 200 with a text/markdown Content-Type', () => {
    const result = parseResponse(exportPageMarkdown, 200, new Headers({ 'Content-Type': 'text/markdown; charset=utf-8' }), markdownFixture);
    expect(result).toBe(markdownFixture);
  });

  it('never attempts JSON.parse on the body — markdown containing `{[` characters round-trips unchanged', () => {
    const trickyMarkdown = '# Title\n\nSee `{[not json` inline code.\n';
    const result = parseResponse(exportPageMarkdown, 200, new Headers({ 'Content-Type': 'text/markdown' }), trickyMarkdown);
    expect(result).toBe(trickyMarkdown);
  });

  it('returns a typed ResponseValidationError when the Content-Type is wrong (e.g. an error page served as text/html)', () => {
    const result = parseResponse(exportPageMarkdown, 200, new Headers({ 'Content-Type': 'text/html' }), '<html>oops</html>');
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('returns a typed ResponseValidationError when the Content-Type header is missing', () => {
    const result = parseResponse(exportPageMarkdown, 200, new Headers(), markdownFixture);
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('classifies a 400 (non-DOCUMENT page) as ValidationError, not a passthrough', () => {
    const result = parseResponse(
      exportPageMarkdown,
      400,
      new Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ error: 'Markdown export is only available for DOCUMENT pages' }),
    );
    expect(isValidationError(result)).toBe(true);
  });

  it('classifies a 403 (no view permission) as PermissionDeniedError', () => {
    const result = parseResponse(exportPageMarkdown, 403, new Headers(), JSON.stringify({ error: 'Forbidden' }));
    expect(isPermissionDeniedError(result)).toBe(true);
  });

  it('classifies a 404 (page not found) as NotFoundError', () => {
    const result = parseResponse(exportPageMarkdown, 404, new Headers(), JSON.stringify({ error: 'Not Found' }));
    expect(isNotFoundError(result)).toBe(true);
  });
});

describe('export.pageMarkdown — metadata', () => {
  it('is a GET, idempotent operation', () => {
    expect(exportPageMarkdown.method).toBe('GET');
  });

  it('requires drive scope', () => {
    expect(exportPageMarkdown.requiredScope).toBe('drive');
  });

  it('is flagged textResponse', () => {
    expect(exportPageMarkdown.textResponse).toBe(true);
  });

  it('declares expectedContentType text/markdown', () => {
    expect(exportPageMarkdown.expectedContentType).toBe('text/markdown');
  });

  it('declares an extended timeoutMsOverride beyond the client default (large-document conversion can run long)', () => {
    expect(exportPageMarkdown.timeoutMsOverride).toBeGreaterThan(30_000);
  });

  it('is not flagged destructive (a read-only export)', () => {
    expect(exportPageMarkdown.destructive).toBeUndefined();
  });
});

describe('export.sheetCsv — request shape', () => {
  it('builds a GET to /api/pages/:pageId/export/csv with no body', () => {
    const request = buildRequest(exportSheetCsv, { pageId: 's1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/pages/s1abc/export/csv');
    expect(request.body).toBeUndefined();
  });

  it('rejects input missing pageId (path param required)', () => {
    const result = exportSheetCsv.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('export.sheetCsv — response contract (textResponse passthrough)', () => {
  it('passes the CSV body through verbatim, including embedded commas/CRLF line endings, on a 200 with text/csv', () => {
    const result = parseResponse(exportSheetCsv, 200, new Headers({ 'Content-Type': 'text/csv; charset=utf-8' }), csvFixture);
    expect(result).toBe(csvFixture);
  });

  it('never attempts JSON.parse on the body — a CSV cell containing `[` and `{` round-trips unchanged', () => {
    const trickyCsv = 'Name,Note\r\n"Smith, Jane","{not json} [1,2]"\r\n';
    const result = parseResponse(exportSheetCsv, 200, new Headers({ 'Content-Type': 'text/csv' }), trickyCsv);
    expect(result).toBe(trickyCsv);
  });

  it('returns a typed ResponseValidationError when the Content-Type is wrong', () => {
    const result = parseResponse(exportSheetCsv, 200, new Headers({ 'Content-Type': 'application/json' }), '{"error":"oops"}');
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('returns a typed ResponseValidationError when the Content-Type header is missing', () => {
    const result = parseResponse(exportSheetCsv, 200, new Headers(), csvFixture);
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('classifies a 400 (non-SHEET page) as ValidationError', () => {
    const result = parseResponse(
      exportSheetCsv,
      400,
      new Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ error: 'CSV export is only available for SHEET pages' }),
    );
    expect(isValidationError(result)).toBe(true);
  });

  it('classifies a 404 (page not found) as NotFoundError', () => {
    const result = parseResponse(exportSheetCsv, 404, new Headers(), JSON.stringify({ error: 'Not Found' }));
    expect(isNotFoundError(result)).toBe(true);
  });
});

describe('export.sheetCsv — metadata', () => {
  it('is a GET, idempotent operation', () => {
    expect(exportSheetCsv.method).toBe('GET');
  });

  it('requires drive scope', () => {
    expect(exportSheetCsv.requiredScope).toBe('drive');
  });

  it('is flagged textResponse', () => {
    expect(exportSheetCsv.textResponse).toBe(true);
  });

  it('declares expectedContentType text/csv', () => {
    expect(exportSheetCsv.expectedContentType).toBe('text/csv');
  });

  it('declares an extended timeoutMsOverride beyond the client default (formula re-evaluation on large sheets can run long)', () => {
    expect(exportSheetCsv.timeoutMsOverride).toBeGreaterThan(30_000);
  });

  it('is not flagged destructive (a read-only export)', () => {
    expect(exportSheetCsv.destructive).toBeUndefined();
  });
});
