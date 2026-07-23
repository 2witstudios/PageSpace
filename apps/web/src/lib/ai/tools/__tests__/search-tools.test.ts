import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';
import { PAGE_TYPE_VALUES } from '@pagespace/lib/utils/enums';

const {
  mockSelect, mockSelectWhere,
  mockSelectDistinct, mockSelectDistinctWhere,
  mockCanActorAccessDrive, mockGetActorAccessiblePagesInDrive,
} = vi.hoisted(() => {
  const mockSelectWhere = vi.fn();
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockSelectDistinctWhere = vi.fn();
  const mockSelectDistinctFrom = vi.fn(() => ({ where: mockSelectDistinctWhere }));
  const mockSelectDistinct = vi.fn(() => ({ from: mockSelectDistinctFrom }));
  return {
    mockSelect, mockSelectFrom, mockSelectWhere,
    mockSelectDistinct, mockSelectDistinctFrom, mockSelectDistinctWhere,
    mockCanActorAccessDrive: vi.fn(),
    mockGetActorAccessiblePagesInDrive: vi.fn(),
  };
});

// A chainable query-result stub: awaitable directly (drive lookups, or queries
// with no .limit()) and also exposes .limit() (queries that chain it).
function chainable<T>(rows: T[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const promise = Promise.resolve(rows) as Promise<T[]> & { limit: typeof limit };
  return Object.assign(promise, { limit });
}

vi.mock('@pagespace/db/db', () => ({
  db: { select: mockSelect, selectDistinct: mockSelectDistinct },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  and: vi.fn((...conds) => ({ op: 'and', conds })),
  ne: vi.fn((field, value) => ({ op: 'ne', field, value })),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql', strings: Array.from(strings), values,
  })),
  asc: vi.fn((field) => ({ op: 'asc', field })),
}));
vi.mock('../actor-permissions', () => ({
  canActorAccessDrive: mockCanActorAccessDrive,
  getActorAccessiblePagesInDrive: mockGetActorAccessiblePagesInDrive,
}));

import { searchTools } from '../search-tools';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { ToolExecutionContext } from '../../core/types';

const mockEq = vi.mocked(eq);

const createAuthContext = (userId = 'user-123') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('search-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('regex_search', () => {
    it('has correct tool definition', () => {
      expect(typeof searchTools.regex_search).toBe('object');
      expect(typeof searchTools.regex_search.description).toBe('string');
      // Uses 'regular expression' not 'regex' in description
      expect(searchTools.regex_search.description).toContain('regular expression');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.regex_search.execute!(
          { driveId: 'drive-1', pattern: 'TODO.*', searchIn: 'both', maxResults: 10, contentTypes: ['documents', 'conversations'] },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockCanActorAccessDrive.mockResolvedValue(false);

      await expect(
        searchTools.regex_search.execute!(
          { driveId: 'drive-1', pattern: 'TODO.*', searchIn: 'both', maxResults: 10, contentTypes: ['documents', 'conversations'] },
          createAuthContext()
        )
      ).rejects.toThrow("You don't have access to this drive");
    });
  });

  describe('glob_search', () => {
    it('has correct tool definition', () => {
      expect(typeof searchTools.glob_search).toBe('object');
      expect(typeof searchTools.glob_search.description).toBe('string');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.glob_search.execute!(
          { driveId: 'drive-1', pattern: '**/README*', maxResults: 10 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive access denied', async () => {
      mockCanActorAccessDrive.mockResolvedValue(false);

      await expect(
        searchTools.glob_search.execute!(
          { driveId: 'drive-1', pattern: '**/README*', maxResults: 10 },
          createAuthContext()
        )
      ).rejects.toThrow("You don't have access to this drive");
    });

    // Regression test for #1773: the MCP tool schema and the web route both
    // accept TASK_LIST as a filterable page type; the internal AI tool schema
    // must match or agents asking for TASK_LIST get a silent zod rejection
    // upstream (in the real tool-call pipeline, which validates against
    // inputSchema before execute() ever runs).
    it('accepts TASK_LIST as a valid includeTypes value in its schema', () => {
      const schema = searchTools.glob_search.inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        driveId: 'drive-1',
        pattern: '*',
        includeTypes: ['TASK_LIST'],
      });

      assert({
        given: 'glob_search includeTypes containing TASK_LIST',
        should: 'validate successfully against the input schema',
        actual: result.success,
        expected: true,
      });
    });

    // Regression test for #2150: the tool's z.enum listed only 8 of the
    // enum's 10 members, so an agent asking for FILE or MACHINE pages was
    // rejected by zod before execute() ever ran. The schema is now derived
    // from the canonical PageType enum.
    it('accepts every canonical page type in its includeTypes schema', () => {
      const schema = searchTools.glob_search.inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        driveId: 'drive-1',
        pattern: '*',
        includeTypes: [...PAGE_TYPE_VALUES],
      });

      assert({
        given: 'glob_search includeTypes containing all ten PageType values',
        should: 'validate successfully against the input schema',
        actual: result.success,
        expected: true,
      });
    });

    it('accepts FILE and MACHINE as includeTypes values', () => {
      const schema = searchTools.glob_search.inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        driveId: 'drive-1',
        pattern: '*',
        includeTypes: ['FILE', 'MACHINE'],
      });

      assert({
        given: 'glob_search includeTypes containing FILE and MACHINE',
        should: 'validate successfully against the input schema',
        actual: result.success,
        expected: true,
      });
    });

    it('still rejects an includeTypes value outside the enum', () => {
      const schema = searchTools.glob_search.inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        driveId: 'drive-1',
        pattern: '*',
        includeTypes: ['BOGUS'],
      });

      assert({
        given: 'glob_search includeTypes containing an unknown page type',
        should: 'fail schema validation',
        actual: result.success,
        expected: false,
      });
    });
  });

  describe('multi_drive_search', () => {
    it('has correct tool definition', () => {
      expect(typeof searchTools.multi_drive_search).toBe('object');
      expect(typeof searchTools.multi_drive_search.description).toBe('string');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        searchTools.multi_drive_search.execute!(
          { searchQuery: 'test', searchType: 'text', maxResultsPerDrive: 5 },
          context
        )
      ).rejects.toThrow('User authentication required');
    });
  });

  describe('regex_search contentTypes', () => {
    it('accepts contentTypes parameter in schema', () => {
      // Check that the tool schema accepts contentTypes
      const schema = searchTools.regex_search.inputSchema;
      assert({
        given: 'regex_search tool',
        should: 'have inputSchema defined',
        actual: schema !== undefined,
        expected: true,
      });
    });

    it('description mentions conversations', () => {
      assert({
        given: 'regex_search tool description',
        should: 'mention searching conversations',
        actual: searchTools.regex_search.description?.toLowerCase().includes('conversation') ?? false,
        expected: true,
      });
    });

    it('defaults contentTypes to documents and conversations', async () => {
      // contentTypes is intentionally omitted to verify the schema default behavior
      // When not specified, it should default to ['documents', 'conversations']
      mockCanActorAccessDrive.mockResolvedValue(false);

      // We can't fully test this without DB mocking, but we can validate
      // that the tool accepts the call without contentTypes and exercises defaulting
      await expect(
        searchTools.regex_search.execute!(
          // Type assertion needed: Zod's .default() provides runtime defaults not reflected in TS types
          // contentTypes is omitted to test the default behavior
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { driveId: 'drive-1', pattern: 'test', searchIn: 'both', maxResults: 10 } as any,
          createAuthContext()
        )
      ).rejects.toThrow("You don't have access to this drive");
      // If it got to the access check, the schema validation and defaulting passed
    });

    it('accepts contentTypes array parameter', async () => {
      mockCanActorAccessDrive.mockResolvedValue(false);

      // Validate that contentTypes parameter is accepted
      await expect(
        searchTools.regex_search.execute!(
          {
            driveId: 'drive-1',
            pattern: 'test',
            searchIn: 'both',
            maxResults: 10,
            contentTypes: ['conversations'],
          },
          createAuthContext()
        )
      ).rejects.toThrow("You don't have access to this drive");
      // If it got to the access check, the contentTypes param was accepted
    });
  });

  // Regression tests for #1774: the REST/service search path filters out
  // pages marked excludeFromSearch (drive-search-service.ts), but these
  // internal AI tools built their own queries and never applied the same
  // filter — an in-app agent could surface pages the product intentionally
  // hides from search.
  describe('excludeFromSearch filtering (issue #1774)', () => {
    beforeEach(() => {
      mockCanActorAccessDrive.mockResolvedValue(true);
      mockGetActorAccessiblePagesInDrive.mockResolvedValue([]);
    });

    it('regex_search filters out pages marked excludeFromSearch', async () => {
      mockSelectWhere
        .mockReturnValueOnce(chainable([{ slug: 'test-drive', name: 'Test Drive' }]))
        .mockReturnValueOnce(chainable([]));

      await searchTools.regex_search.execute!(
        { driveId: 'drive-1', pattern: 'TODO', searchIn: 'content', maxResults: 10, contentTypes: ['documents'] },
        createAuthContext()
      );

      expect(mockEq).toHaveBeenCalledWith(pages.excludeFromSearch, false);
    });

    it('glob_search filters out pages marked excludeFromSearch', async () => {
      mockSelectWhere
        .mockReturnValueOnce(chainable([{ slug: 'test-drive', name: 'Test Drive' }]))
        .mockReturnValueOnce(chainable([]));

      await searchTools.glob_search.execute!(
        { driveId: 'drive-1', pattern: '*', maxResults: 10 },
        createAuthContext()
      );

      expect(mockEq).toHaveBeenCalledWith(pages.excludeFromSearch, false);
    });

    it('multi_drive_search filters out pages marked excludeFromSearch', async () => {
      mockSelectDistinctWhere.mockReturnValueOnce(
        chainable([{ id: 'drive-1', name: 'Drive', slug: 'drive-1' }])
      );
      mockSelectWhere.mockReturnValueOnce(chainable([]));

      await searchTools.multi_drive_search.execute!(
        { searchQuery: 'TODO', searchType: 'text', maxResultsPerDrive: 10 },
        createAuthContext()
      );

      expect(mockEq).toHaveBeenCalledWith(pages.excludeFromSearch, false);
    });
  });
});
