/**
 * @scaffold - ORM chain mocks present (transaction mock with select().from().where()).
 * Pending search-repository seam extraction for full rubric compliance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTransaction = vi.hoisted(() => vi.fn());
const mockGetUserAccessLevel = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db', () => ({
  db: {
    transaction: mockTransaction,
  },
  pages: {
    id: 'pages.id',
    title: 'pages.title',
    type: 'pages.type',
    parentId: 'pages.parentId',
    content: 'pages.content',
    driveId: 'pages.driveId',
    isTrashed: 'pages.isTrashed',
  },
  drives: {
    id: 'drives.id',
    slug: 'drives.slug',
    name: 'drives.name',
  },
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  inArray: vi.fn((a, b) => ({ op: 'inArray', a, b })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: Array.from(strings),
    values,
  })),
}));

vi.mock('../../permissions/permissions', () => ({
  getUserAccessLevel: mockGetUserAccessLevel,
  getUserDriveAccess: vi.fn(),
}));

import { regexSearchPages } from '../drive-search-service';

type SearchRow = {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  content: string;
};

function setupTransactionResult(rows: SearchRow[]) {
  const execute = vi.fn().mockResolvedValue(undefined);
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<SearchRow[]>) =>
    callback({ execute, select })
  );

  return { execute, select, from, where, limit };
}

describe('regexSearchPages security behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAccessLevel.mockResolvedValue({ canView: true });
  });

  it('returns line previews for literal patterns without compiling user regex', async () => {
    const rows: SearchRow[] = [
      {
        id: 'page-1',
        title: 'Alpha',
        type: 'DOCUMENT',
        parentId: null,
        // Case-sensitive: only 'hello' matches, not 'HELLO' (aligns with PostgreSQL ~ operator)
        content: 'hello world\nnothing here\nhello again',
      },
    ];

    const { execute } = setupTransactionResult(rows);
    const response = await regexSearchPages('drive-1', 'user-1', 'hello', null, {
      searchIn: 'content',
      maxResults: 50,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.totalResults).toBe(1);
    expect(response.results[0]?.matchingLines).toEqual([
      { lineNumber: 1, content: 'hello world' },
      { lineNumber: 3, content: 'hello again' },
    ]);
    expect(response.results[0]?.totalMatches).toBe(2);
  });

  it('skips line previews for non-literal regex patterns', async () => {
    const rows: SearchRow[] = [
      {
        id: 'page-1',
        title: 'ReDoS Test',
        type: 'DOCUMENT',
        parentId: null,
        content: `${'A'.repeat(60)}!`,
      },
    ];

    setupTransactionResult(rows);
    const response = await regexSearchPages('drive-1', 'user-1', '(A+)+$', null, {
      searchIn: 'content',
      maxResults: 50,
    });

    expect(response.totalResults).toBe(1);
    expect(response.results[0]?.matchingLines).toEqual([]);
    expect(response.results[0]?.totalMatches).toBe(0);
  });

  it('returns a stable response when PostgreSQL cancels due to statement timeout', async () => {
    mockTransaction.mockRejectedValue({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });

    const response = await regexSearchPages('drive-1', 'user-1', '(A+)+$', null, {
      searchIn: 'content',
      maxResults: 50,
    });

    expect(response.totalResults).toBe(0);
    expect(response.results).toEqual([]);
    expect(response.summary).toContain('timed out');
    expect(response.stats).toEqual({
      pagesScanned: 0,
      pagesWithAccess: 0,
      documentTypes: [],
    });
  });
});
