import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { globSearch, multiDriveSearch, regexSearch } from '../search.js';

const config = { baseUrl: 'https://pagespace.ai' };

// ---------------------------------------------------------------------------
// search.glob — /api/drives/:driveId/search/glob (route.ts, drive-search-service.ts globSearchPages)
// ---------------------------------------------------------------------------

const globFixture = {
  success: true,
  driveSlug: 'engineering',
  pattern: '**/README*',
  results: [
    {
      pageId: 'p1abc',
      title: 'README',
      type: 'DOCUMENT',
      semanticPath: '/engineering/README',
      matchedOn: 'title',
    },
  ],
  totalResults: 1,
  summary: 'Found 1 page matching pattern "**/README*"',
  stats: {
    totalPagesScanned: 42,
    matchingPages: 1,
    documentTypes: ['DOCUMENT'],
    matchTypes: { path: 0, title: 1 },
  },
  nextSteps: [
    'Use read_page with the pageId to examine content',
    'Use the semantic paths to understand the structure',
  ],
};

describe('search.glob — request shape', () => {
  it('interpolates :driveId and sends pattern as a query param', () => {
    const request = buildRequest(globSearch, { driveId: 'd1abc', pattern: '**/README*' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/search/glob?pattern=**%2FREADME*');
    expect(request.body).toBeUndefined();
  });

  it('serializes maxResults as a query param', () => {
    const request = buildRequest(globSearch, { driveId: 'd1abc', pattern: '*.md', maxResults: 25 }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/search/glob?maxResults=25&pattern=*.md');
  });

  it('serializes includeTypes as the comma-separated string the route expects (route.ts:53-57 uses a single .get() + split(","), not repeated query keys)', () => {
    const request = buildRequest(
      globSearch,
      { driveId: 'd1abc', pattern: '*', includeTypes: 'CODE,TASK_LIST' },
      config,
    );
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/search/glob?includeTypes=CODE%2CTASK_LIST&pattern=*');
  });
});

describe('search.glob — input validation', () => {
  it('rejects an empty pattern', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '' });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults above the route bound of 200 (route.ts:39-43)', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '*', maxResults: 201 });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults below 1', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '*', maxResults: 0 });
    expect(result.success).toBe(false);
  });

  it('accepts includeTypes drawn from the route\'s type set — the full canonical PageType enum (#2150; the route now derives its filter from the enum)', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '*', includeTypes: 'CODE,TASK_LIST' });
    expect(result.success).toBe(true);
  });

  it('accepts FILE and MACHINE, which the inlined list used to omit (#2150)', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '*', includeTypes: 'FILE,MACHINE' });
    expect(result.success).toBe(true);
  });

  it('rejects an includeTypes entry outside the route\'s type set', () => {
    const result = globSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '*', includeTypes: 'CODE,BOGUS' });
    expect(result.success).toBe(false);
  });
});

describe('search.glob — response contract', () => {
  it('parses a GlobSearchResponse (route truth, globSearchPages)', () => {
    const result = parseResponse(globSearch, 200, new Headers(), JSON.stringify(globFixture));
    expect(result).toEqual(globFixture);
  });

  it('parses an empty-result response', () => {
    const empty = {
      ...globFixture,
      results: [],
      totalResults: 0,
      stats: { totalPagesScanned: 42, matchingPages: 0, documentTypes: [], matchTypes: { path: 0, title: 0 } },
    };
    const result = parseResponse(globSearch, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });

  it('rejects a response that drifts from the GlobSearchResponse contract', () => {
    const malformed = { ...globFixture, results: [{ ...globFixture.results[0], matchedOn: 'body' }] };
    const result = parseResponse(globSearch, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 as PermissionDeniedError, never a schema mismatch', () => {
    const result = parseResponse(globSearch, 403, new Headers(), JSON.stringify({ error: "You don't have access to this drive" }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('search.glob — metadata', () => {
  it('declares the drive-scope requirement (driveId-bound view access, per ADR 0002)', () => {
    expect(globSearch.requiredScope).toBe('drive');
  });
});

// ---------------------------------------------------------------------------
// search.regex — /api/drives/:driveId/search/regex (route.ts, drive-search-service.ts regexSearchPages)
// ---------------------------------------------------------------------------

const regexFixture = {
  success: true,
  driveSlug: 'engineering',
  pattern: 'TODO.*urgent',
  searchIn: 'content',
  results: [
    {
      pageId: 'p1abc',
      title: 'Design Doc',
      type: 'DOCUMENT',
      semanticPath: '/engineering/Design Doc',
      matchingLines: [{ lineNumber: 12, content: '// TODO: urgent fix needed' }],
      totalMatches: 1,
    },
  ],
  totalResults: 1,
  summary: 'Found 1 page matching pattern "TODO.*urgent"',
  stats: { pagesScanned: 10, pagesWithAccess: 1, documentTypes: ['DOCUMENT'] },
  nextSteps: ['Use read_page with the pageId to examine full content'],
};

describe('search.regex — request shape', () => {
  it('interpolates :driveId and sends pattern as a query param', () => {
    const request = buildRequest(regexSearch, { driveId: 'd1abc', pattern: 'TODO.*urgent' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/search/regex?pattern=TODO.*urgent');
    expect(request.body).toBeUndefined();
  });

  it('serializes searchIn and maxResults as query params', () => {
    const request = buildRequest(regexSearch, { driveId: 'd1abc', pattern: 'x', searchIn: 'both', maxResults: 10 }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1abc/search/regex?maxResults=10&pattern=x&searchIn=both');
  });

  it('passes the pattern through verbatim — the server owns pattern safety, the SDK does not sanitize', () => {
    const request = buildRequest(regexSearch, { driveId: 'd1abc', pattern: '\\d{4}-\\d{2}-\\d{2}' }, config);
    expect(request.url).toContain(encodeURIComponent('\\d{4}-\\d{2}-\\d{2}'));
  });
});

describe('search.regex — input validation', () => {
  it('rejects an empty pattern', () => {
    const result = regexSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid searchIn value (route only accepts content/title/both, route.ts:35)', () => {
    const result = regexSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: 'x', searchIn: 'everywhere' });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults above the route bound of 100 (route.ts:36-40)', () => {
    const result = regexSearch.inputSchema.safeParse({ driveId: 'd1abc', pattern: 'x', maxResults: 101 });
    expect(result.success).toBe(false);
  });
});

describe('search.regex — response contract', () => {
  it('parses a RegexSearchResponse (route truth, regexSearchPages)', () => {
    const result = parseResponse(regexSearch, 200, new Headers(), JSON.stringify(regexFixture));
    expect(result).toEqual(regexFixture);
  });

  it('parses an empty-result response', () => {
    const empty = { ...regexFixture, results: [], totalResults: 0, stats: { pagesScanned: 0, pagesWithAccess: 0, documentTypes: [] } };
    const result = parseResponse(regexSearch, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });

  it('rejects a response missing matchingLines on a result row', () => {
    const malformed = { ...regexFixture, results: [{ ...regexFixture.results[0] }] } as Record<string, unknown>;
    const rows = malformed.results as Array<Record<string, unknown>>;
    delete rows[0]!.matchingLines;
    const result = parseResponse(regexSearch, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 400 (missing pattern) as ValidationError, never a schema mismatch', () => {
    const result = parseResponse(regexSearch, 400, new Headers(), JSON.stringify({ error: 'Pattern parameter is required' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('search.regex — metadata', () => {
  it('declares the drive-scope requirement, matching search.glob', () => {
    expect(regexSearch.requiredScope).toBe('drive');
  });
});

// ---------------------------------------------------------------------------
// search.multiDrive — /api/search/multi-drive (route.ts, no driveId path param)
// ---------------------------------------------------------------------------

const multiDriveFixture = {
  success: true,
  searchQuery: 'quarterly report',
  searchType: 'text',
  results: [
    {
      driveId: 'd1abc',
      driveName: 'Engineering',
      driveSlug: 'engineering',
      matches: [{ pageId: 'p1abc', title: 'Q3 Report', type: 'DOCUMENT', excerpt: 'quarterly report summary...' }],
      count: 1,
    },
  ],
  totalDrives: 1,
  totalMatches: 1,
  summary: 'Found 1 matches across 1 drive',
  stats: { drivesSearched: 3, drivesWithResults: 1, totalMatches: 1 },
  nextSteps: ['Use read_page with specific pageIds to examine content'],
};

describe('search.multiDrive — request shape', () => {
  it('builds a GET to /api/search/multi-drive with no path params', () => {
    const request = buildRequest(multiDriveSearch, { searchQuery: 'quarterly report' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/search/multi-drive?searchQuery=quarterly+report');
    expect(request.body).toBeUndefined();
  });

  it('serializes searchType and maxResultsPerDrive as query params', () => {
    const request = buildRequest(
      multiDriveSearch,
      { searchQuery: 'x', searchType: 'regex', maxResultsPerDrive: 5 },
      config,
    );
    expect(request.url).toBe('https://pagespace.ai/api/search/multi-drive?maxResultsPerDrive=5&searchQuery=x&searchType=regex');
  });
});

describe('search.multiDrive — input validation', () => {
  it('rejects an empty searchQuery', () => {
    const result = multiDriveSearch.inputSchema.safeParse({ searchQuery: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid searchType (route only accepts text/regex, route.ts:39)', () => {
    const result = multiDriveSearch.inputSchema.safeParse({ searchQuery: 'x', searchType: 'fuzzy' });
    expect(result.success).toBe(false);
  });

  it('rejects maxResultsPerDrive above the route bound of 50 (route.ts:26-30)', () => {
    const result = multiDriveSearch.inputSchema.safeParse({ searchQuery: 'x', maxResultsPerDrive: 51 });
    expect(result.success).toBe(false);
  });
});

describe('search.multiDrive — response contract', () => {
  it('parses a multi-drive response grouped per-drive (route truth, :242-264)', () => {
    const result = parseResponse(multiDriveSearch, 200, new Headers(), JSON.stringify(multiDriveFixture));
    expect(result).toEqual(multiDriveFixture);
  });

  it('parses the zero-accessible-drives short-circuit response (route.ts:50-68)', () => {
    const zeroDrives = {
      success: true,
      searchQuery: 'x',
      searchType: 'text',
      results: [],
      totalDrives: 0,
      totalMatches: 0,
      summary: 'Found 0 matches across 0 drives',
      stats: { drivesSearched: 0, drivesWithResults: 0, totalMatches: 0 },
      nextSteps: ['Try a different search query'],
    };
    const result = parseResponse(multiDriveSearch, 200, new Headers(), JSON.stringify(zeroDrives));
    expect(result).toEqual(zeroDrives);
  });

  it('rejects a response with a malformed per-drive group (missing driveSlug)', () => {
    const malformed = { ...multiDriveFixture, results: [{ ...multiDriveFixture.results[0] }] } as Record<string, unknown>;
    const rows = malformed.results as Array<Record<string, unknown>>;
    delete rows[0]!.driveSlug;
    const result = parseResponse(multiDriveSearch, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 400 (missing searchQuery) as ValidationError, never a schema mismatch', () => {
    const result = parseResponse(multiDriveSearch, 400, new Headers(), JSON.stringify({ error: 'searchQuery parameter is required' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('search.multiDrive — metadata', () => {
  it('has no single-drive scope requirement — it enumerates the caller\'s own accessible drives (matches drives.list precedent)', () => {
    expect(multiDriveSearch.requiredScope).toBeUndefined();
  });

  it('is named and described for MCP/CLI derivation', () => {
    expect(multiDriveSearch.name).toBe('search.multiDrive');
    expect(multiDriveSearch.description.length).toBeGreaterThan(0);
  });
});
