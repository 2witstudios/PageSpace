/**
 * `read_sheet` (issue #2467).
 *
 * The tool is a facade, so most of these cases are about the facade's own
 * failure modes rather than about querying: that it hands the store the
 * arguments it was given instead of reimplementing them, that the two paging
 * coordinate systems cannot be silently mixed, and that a read never quietly
 * answers a different question than the one asked — a crippled agent that gets
 * no error is the worst outcome here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

const mockGetTab = vi.fn();
const mockListTabs = vi.fn();
const mockReadRows = vi.fn();
const mockQueryRows = vi.fn();
const mockEnsureTab = vi.fn();

vi.mock('@pagespace/lib/sheets/store', () => ({
  getTab: (...args: unknown[]) => mockGetTab(...args as []),
  listTabs: (...args: unknown[]) => mockListTabs(...args as []),
  readRows: (...args: unknown[]) => mockReadRows(...args as []),
  queryRows: (...args: unknown[]) => mockQueryRows(...args as []),
  ensureTab: (...args: unknown[]) => mockEnsureTab(...args as []),
}));

vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: { findById: vi.fn() },
}));

vi.mock('../actor-permissions', () => ({
  canActorViewPage: vi.fn(),
  canActorEditPage: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: (id: string) => `***${id?.slice(-4) ?? ''}`,
}));

import { sheetReadTools } from '../sheet-read-tools';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { canActorViewPage, canActorEditPage } from '../actor-permissions';
import { SheetQueryError } from '@pagespace/lib/sheets/query';
import type { ToolExecutionContext } from '../../core/types';

const mockFindById = vi.mocked(pageRepository.findById);
const mockCanView = vi.mocked(canActorViewPage);
const mockCanEdit = vi.mocked(canActorEditPage);

const sheetPage = {
  id: 'page-1',
  title: 'Members',
  type: 'SHEET' as const,
  content: '',
  contentMode: 'html' as const,
  driveId: 'drive-1',
  parentId: null,
  position: 1,
  isTrashed: false,
  trashedAt: null,
  revision: 1,
  stateHash: null,
};

const tab = { id: 'tab-1', tabIndex: 0, name: 'Sheet1', rowCount: 500, columnCount: 16 };

const context = {
  toolCallId: '1',
  messages: [],
  experimental_context: { userId: 'user-123' } as ToolExecutionContext,
};

// The tool's return type is a union of a success envelope and several
// self-correcting error envelopes; tests read fields off whichever came back.
type Result = Record<string, unknown>;

// `execute`'s declared return is a union of every result envelope, which does
// not overlap `Promise<Result>` structurally — the widening goes through
// `unknown` deliberately rather than being asserted between two shapes TS can
// see are different.
const run = (input: Record<string, unknown>) =>
  sheetReadTools.read_sheet.execute!(input as never, context) as unknown as Promise<Result>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({ ...sheetPage });
  mockCanView.mockResolvedValue(true);
  mockCanEdit.mockResolvedValue(true);
  mockListTabs.mockResolvedValue([tab]);
  mockGetTab.mockResolvedValue(tab);
  mockReadRows.mockResolvedValue([]);
  mockQueryRows.mockResolvedValue({ rows: [], total: 0, hasMore: false });
});

describe('read_sheet — authentication and page type', () => {
  it('requires an authenticated user', async () => {
    await expect(
      sheetReadTools.read_sheet.execute!(
        { pageId: 'page-1' } as never,
        { toolCallId: '1', messages: [], experimental_context: {} } as never
      )
    ).rejects.toThrow('User authentication required');
  });

  it('refuses a page that is not a sheet, and names the tool that reads it', async () => {
    mockFindById.mockResolvedValue({ ...sheetPage, type: 'DOCUMENT' as const });
    const result = await run({ pageId: 'page-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Page is not a sheet');
    expect(String(result.suggestion)).toContain('read_page');
  });

  it('does not disclose a page the caller cannot view, even to say it is the wrong type', async () => {
    // The wrong-type refusal quotes the page's real title and type. Running it
    // before the permission check turned read_sheet into a probe that reads
    // titles out of any drive, one page id at a time.
    mockFindById.mockResolvedValue({ ...sheetPage, type: 'DOCUMENT' as const, title: 'Q3 Layoffs' });
    mockCanView.mockResolvedValue(false);

    await expect(run({ pageId: 'page-1' })).rejects.toThrow('Insufficient permissions');
  });

  it('refuses a reader without view permission', async () => {
    mockCanView.mockResolvedValue(false);
    await expect(run({ pageId: 'page-1' })).rejects.toThrow('Insufficient permissions');
  });
});

describe('read_sheet — range reads', () => {
  it('translates the 1-based startRow an agent reads into the 0-based index the store wants', async () => {
    // The off-by-one this guards is the whole reason the parameter is named
    // differently from the MCP route's `fromRow`: the number in front of a row
    // is its A1 row, and asking for row 417 must not return row 418.
    mockReadRows.mockResolvedValue([{ rowIndex: 416, cells: { A: { raw: 'x', value: 'x' } } }]);

    const result = await run({ pageId: 'page-1', startRow: 417, limit: 1 });

    const [, options] = mockReadRows.mock.calls[0] as [string, { fromRow: number }];
    expect(options.fromRow).toBe(416);
    expect((result.rows as { rowNumber: number }[])[0].rowNumber).toBe(417);
  });

  it('reports the sheet dimensions even when the window is empty', async () => {
    // An agent that reads past the end must learn the sheet has 500 rows, not
    // conclude it is empty.
    const result = await run({ pageId: 'page-1', startRow: 900 });

    assert({
      given: 'a range read past the last row',
      should: 'still report the sheet dimensions',
      actual: result.dimensions,
      expected: { rowCount: 500, columnCount: 16 },
    });
  });

  it('points at the next row position when more rows remain', async () => {
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'a', value: 'a' } } },
      { rowIndex: 1, cells: { A: { raw: 'b', value: 'b' } } },
    ]);

    const result = await run({ pageId: 'page-1', limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.nextStartRow).toBe(3);
    expect(String((result.nextSteps as string[])[0])).toContain('startRow: 3');
  });

  it('renders the rows as a table whose line numbers are the sheet rows', async () => {
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'memid', value: 'memid' }, B: { raw: 'name', value: 'name' } } },
      { rowIndex: 1, cells: { A: { raw: '28605', value: 28605 }, B: { raw: 'Acme', value: 'Acme' } } },
    ]);

    const result = await run({ pageId: 'page-1' });
    expect(result.table).toBe('columns→A | B\n1→memid | name\n2→28605 | Acme');
  });
});

describe('read_sheet — projection and refusals', () => {
  it('projects a range read too, not only a filtered one', async () => {
    // `select` without `where` took the range branch, where projection was
    // applied to the rendered table and the reported column list but NOT to the
    // structured rows — so an agent asking for two of sixteen columns still got
    // all sixteen, in a response that claimed to have two.
    mockReadRows.mockResolvedValue([
      {
        rowIndex: 0,
        cells: {
          A: { raw: 'keep', value: 'keep' },
          B: { raw: 'drop', value: 'drop' },
          C: { raw: 'keep2', value: 'keep2' },
        },
      },
    ]);

    const result = await run({ pageId: 'page-1', select: ['A', 'C'] });

    assert({
      given: 'a range read with select',
      should: 'return only the projected columns in the structured rows',
      actual: (result.rows as { cells: Record<string, string> }[])[0].cells,
      expected: { A: 'keep', C: 'keep2' },
    });
    expect(result.columns).toEqual(['A', 'C']);
  });

  it('refuses a tab index the sheet does not have, listing the ones it does', async () => {
    mockGetTab.mockResolvedValue(null);

    const result = await run({ pageId: 'page-1', tabIndex: 4 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sheet tab not found');
    expect(String(result.message)).toContain('0 ("Sheet1")');
    expect(result.tabs).toEqual([
      { tabIndex: 0, name: 'Sheet1', rowCount: 500, columnCount: 16 },
    ]);
  });

  it('gives a filtered read the same tab refusal as a range read', async () => {
    // Two paths can discover a bad tab index; they must not describe it two
    // different ways, and neither may answer with another tab's rows.
    mockGetTab.mockResolvedValue(null);

    const result = await run({
      pageId: 'page-1',
      tabIndex: 4,
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sheet tab not found');
    expect(result.tabs).toEqual([
      { tabIndex: 0, name: 'Sheet1', rowCount: 500, columnCount: 16 },
    ]);
    expect(mockQueryRows).not.toHaveBeenCalled();
  });

  it('reports an unparseable sheet as unreadable, never as empty', async () => {
    // The one answer that invites an agent to overwrite content that is still
    // intact is "this spreadsheet is blank".
    mockListTabs.mockResolvedValue([]);
    mockFindById.mockResolvedValue({
      ...sheetPage,
      content: '#%PAGESPACE_SHEETDOC v1\n[[sheets]]\nname = "Broken"\nthis is not toml = = =',
    });

    const result = await run({ pageId: 'page-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sheet content could not be read');
    expect(String(result.suggestion)).toContain('do not overwrite');
    expect(result.rows).toBeUndefined();
  });
});

describe('read_sheet — filtered reads', () => {
  it('compiles a single condition to the store filter, without a wrapper', async () => {
    await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'C', op: 'eq', value: '28605' }] },
    });

    const [ref, options] = mockQueryRows.mock.calls[0] as [
      unknown,
      { where: unknown; limit: number },
    ];
    assert({
      given: 'a lookup by key column',
      should: 'pass the condition straight to the row store',
      actual: { ref, where: options.where },
      expected: {
        ref: { pageId: 'page-1', tabIndex: 0 },
        where: { column: 'C', op: 'eq', value: '28605' },
      },
    });
  });

  it('combines several conditions with AND by default and OR on request', async () => {
    const conditions = [
      { column: 'A', op: 'eq' as const, value: 'x' },
      { column: 'B', op: 'contains' as const, value: 'y' },
    ];

    await run({ pageId: 'page-1', where: { conditions } });
    await run({ pageId: 'page-1', where: { match: 'any', conditions } });

    const first = (mockQueryRows.mock.calls[0] as [unknown, { where: unknown }])[1].where;
    const second = (mockQueryRows.mock.calls[1] as [unknown, { where: unknown }])[1].where;
    expect(first).toEqual({ and: conditions });
    expect(second).toEqual({ or: conditions });
  });

  it('hands projection and sorting to the store rather than doing them here', async () => {
    await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
      select: ['A', 'C'],
      orderBy: [{ column: 'C', direction: 'desc', numeric: true }],
      offset: 40,
      limit: 20,
    });

    const [, options] = mockQueryRows.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options.select).toEqual(['A', 'C']);
    expect(options.orderBy).toEqual([{ column: 'C', direction: 'desc', numeric: true }]);
    expect(options.offset).toBe(40);
    expect(options.limit).toBe(20);
  });

  it('reads an empty select as no projection, on both paths', async () => {
    // The range path read `[]` as "no projection"; `queryRows` treats the empty
    // array as truthy and projects to nothing. So `select: []` with a filter
    // answered "12 matching rows" and twelve rows of `cells: {}` — a wrong
    // answer that looks like a right one.
    mockQueryRows.mockResolvedValue({
      rows: [{ rowIndex: 0, cells: { A: { raw: 'kept', value: 'kept' } } }],
      total: 1,
      hasMore: false,
    });

    await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
      select: [],
    });

    const [, options] = mockQueryRows.mock.calls[0] as [unknown, { select?: string[] }];
    expect(options.select).toBeUndefined();
  });

  it('reports columns in the order the table header uses', async () => {
    // A model mapping table positions by `columns` would swap them if the two
    // disagreed.
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'a', value: 'a' }, C: { raw: 'c', value: 'c' } } },
    ]);

    const result = await run({ pageId: 'page-1', select: ['C', 'A'] });

    expect(result.columns).toEqual(['A', 'C']);
    expect(String(result.table).split('\n')[0]).toBe('columns→A | C');
  });

  it('reports projected columns even when every matching row leaves one empty', async () => {
    mockQueryRows.mockResolvedValue({
      rows: [{ rowIndex: 0, cells: { A: { raw: 'x', value: 'x' } } }],
      total: 1,
      hasMore: false,
    });

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
      select: ['A', 'C'],
    });

    expect(result.columns).toEqual(['A', 'C']);
  });

  it('reports the total match count and where to continue paging', async () => {
    mockQueryRows.mockResolvedValue({
      rows: [{ rowIndex: 5, cells: { A: { raw: 'x', value: 'x' } } }],
      total: 12,
      hasMore: true,
    });

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
      offset: 3,
      limit: 1,
    });

    expect(result.matchedRows).toBe(12);
    expect(result.nextOffset).toBe(4);
    expect(String((result.nextSteps as string[])[0])).toContain('offset: 4');
  });

  it('omits nextOffset when no matches follow', async () => {
    // Emitting `nextOffset: null` beside `hasMore: false` invites an agent that
    // branches on the field's presence into a guaranteed-empty call — the same
    // reason nextStartRow is suppressed.
    mockQueryRows.mockResolvedValue({
      rows: [{ rowIndex: 0, cells: { A: { raw: 'x', value: 'x' } } }],
      total: 1,
      hasMore: false,
    });

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'isNotEmpty' }] },
    });

    expect(result.hasMore).toBe(false);
    expect('nextOffset' in result).toBe(false);
  });

  it('turns a bad column or filter into a correctable answer, not a thrown failure', async () => {
    mockQueryRows.mockRejectedValue(new SheetQueryError('Invalid column: 1'));

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'AA', op: 'eq', value: 'x' }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid filter or sort');
    expect(result.message).toBe('Invalid column: 1');
  });
});

describe('read_sheet — what counts as a filtered read', () => {
  // `isFiltered` decides which engine answers. If it ever narrowed to check
  // only `where`, an orderBy-only call would take the POSITIONAL path and come
  // back in row order while the caller believed it was sorted — plausible,
  // ordered, and wrong, which is the failure mode this tool exists to remove.
  it('sends an orderBy-only read to the store, not to the positional path', async () => {
    await run({ pageId: 'page-1', orderBy: [{ column: 'C', direction: 'desc' }] });

    expect(mockQueryRows).toHaveBeenCalledTimes(1);
    expect(mockReadRows).not.toHaveBeenCalled();
    const [, options] = mockQueryRows.mock.calls[0] as [unknown, { orderBy: unknown }];
    expect(options.orderBy).toEqual([{ column: 'C', direction: 'desc' }]);
  });

  it('sends an offset-only read to the store too', async () => {
    // offset pages MATCHES; answering it positionally would page something else.
    await run({ pageId: 'page-1', offset: 10 });

    expect(mockQueryRows).toHaveBeenCalledTimes(1);
    expect(mockReadRows).not.toHaveBeenCalled();
  });

  it('treats offset: 0 as no offset at all', async () => {
    // Models fill `offset: 0` in as a harmless default. Counting it as a filter
    // pushed a plain positional read onto the filtered path, where it was
    // rejected for combining with startRow or refused as "not migrated".
    const result = await run({ pageId: 'page-1', startRow: 5, limit: 10, offset: 0 });

    expect(result.success).toBe(true);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockQueryRows).not.toHaveBeenCalled();
  });

  it('treats an empty orderBy as no ordering at all', async () => {
    // `compileOrderBy([])` returns undefined — no sort was ever requested — so
    // counting it as a filter derailed a plain positional read, same as
    // `offset: 0` and `select: []` did.
    const result = await run({ pageId: 'page-1', startRow: 10, limit: 20, orderBy: [] });

    expect(result.success).toBe(true);
    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockQueryRows).not.toHaveBeenCalled();
  });

  it('sends a plain read to the positional path', async () => {
    await run({ pageId: 'page-1', limit: 5 });

    expect(mockReadRows).toHaveBeenCalledTimes(1);
    expect(mockQueryRows).not.toHaveBeenCalled();
  });
});

describe('read_sheet — the two paging models cannot be mixed', () => {
  it('rejects startRow combined with a filter instead of ignoring one of them', async () => {
    // Silently dropping startRow would hand back matches from the top of the
    // sheet while the agent believed it had paged past them — the class of
    // quiet wrong answer this tool exists to remove.
    const result = await run({
      pageId: 'page-1',
      startRow: 100,
      where: { conditions: [{ column: 'A', op: 'eq', value: 'x' }] },
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('startRow cannot be combined');
    expect(mockQueryRows).not.toHaveBeenCalled();
    expect(mockReadRows).not.toHaveBeenCalled();
  });

  it('rejects startRow combined with offset', async () => {
    const result = await run({ pageId: 'page-1', startRow: 10, offset: 5 });
    expect(result.success).toBe(false);
  });
});

describe('read_sheet — sheet not yet migrated to row storage', () => {
  beforeEach(() => {
    mockListTabs.mockResolvedValue([]);
    mockGetTab.mockResolvedValue(null);
  });

  it('reads a range from the stored document without writing anything', async () => {
    mockFindById.mockResolvedValue({
      ...sheetPage,
      content: [
        '#%PAGESPACE_SHEETDOC v1',
        'page_id = "page-1"',
        '',
        '[[sheets]]',
        'name = "Legacy"',
        'order = 0',
        '',
        '[sheets.meta]',
        'row_count = 2',
        'column_count = 1',
        '',
        '[sheets.cells.A1]',
        'value = "Item"',
        'type = "string"',
      ].join('\n'),
    });

    const result = await run({ pageId: 'page-1' });

    expect(result.materialized).toBe(false);
    expect((result.rows as { cells: Record<string, string> }[])[0].cells).toEqual({ A: 'Item' });
    expect(mockEnsureTab).not.toHaveBeenCalled();
  });

  it('refuses a filtered read of an unmigrated sheet rather than writing to migrate it', async () => {
    // read-only mode is enforced by stripping WRITE_TOOLS, and read_sheet
    // cannot be in that set without taking away every sheet READ. The tool
    // cannot see the toggle, so the only way to keep the product's documented
    // "no writes" promise is for a read never to write — for anyone.
    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'eq', value: 'x' }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Sheet not migrated to row storage');
    expect(String(result.suggestion)).toContain('startRow/limit');
    expect(mockQueryRows).not.toHaveBeenCalled();
    expect(mockEnsureTab).not.toHaveBeenCalled();
  });

  it('refuses a legacy-text SHEET page instead of calling it a blank spreadsheet', async () => {
    mockListTabs.mockResolvedValue([]);
    mockFindById.mockResolvedValue({ ...sheetPage, content: '<p>Notes, never a grid</p>' });

    const result = await run({ pageId: 'page-1' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Page holds text, not a spreadsheet');
    expect(String(result.suggestion)).toContain('read_page');
    expect(result.rows).toBeUndefined();
  });

  it('never materialises a legacy-text page, which would hide its text forever', async () => {
    // `materializeFromDocument` does NOT throw on text — it parses to an empty
    // 20x10 sheet and inserts a tab with zero rows. After that every read takes
    // the store path, documentIsNotASheet can never be true again, and the
    // page's text is invisible to read_page, list_pages and command injection
    // permanently. One filtered read would have been enough to cause it.
    mockListTabs.mockResolvedValue([]);
    mockFindById.mockResolvedValue({ ...sheetPage, content: '<p>Notes, never a grid</p>' });

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'eq', value: 'x' }] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Page holds text, not a spreadsheet');
    expect(mockEnsureTab).not.toHaveBeenCalled();
    expect(mockQueryRows).not.toHaveBeenCalled();
  });

});

describe('read_sheet — every refusal is actionable', () => {
  // The issue this PR closes is not "sheets error badly", it is that an agent
  // could not tell what to do next. A refusal without a way forward is the same
  // dead end in a different costume, so this drives EVERY failure envelope the
  // tool can produce and asserts each names one.
  const refusals: Array<[string, () => Promise<Result>]> = [
    ['wrong page type', async () => {
      mockFindById.mockResolvedValue({ ...sheetPage, type: 'DOCUMENT' as const });
      return run({ pageId: 'page-1' });
    }],
    ['startRow with a filter', async () =>
      run({ pageId: 'page-1', startRow: 4, where: { conditions: [{ column: 'A', op: 'eq', value: 'x' }] } })],
    ['tab not found', async () => {
      mockGetTab.mockResolvedValue(null);
      return run({ pageId: 'page-1', tabIndex: 9 });
    }],
    ['not a spreadsheet', async () => {
      mockListTabs.mockResolvedValue([]);
      mockFindById.mockResolvedValue({ ...sheetPage, content: '<p>text</p>' });
      return run({ pageId: 'page-1' });
    }],
    ['unmigrated + filtered', async () => {
      mockListTabs.mockResolvedValue([]);
      return run({ pageId: 'page-1', where: { conditions: [{ column: 'A', op: 'eq', value: 'x' }] } });
    }],
    ['invalid filter', async () => {
      mockQueryRows.mockRejectedValue(new SheetQueryError('Invalid column: 1'));
      return run({ pageId: 'page-1', where: { conditions: [{ column: 'AA', op: 'eq', value: 'x' }] } });
    }],
  ];

  it.each(refusals)('%s says what to do next', async (_label, produce) => {
    const result = await produce();

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(typeof result.message).toBe('string');
    // The load-bearing one: a next step, not just a diagnosis.
    expect(typeof result.suggestion, 'refusal carries no suggestion').toBe('string');
    expect(String(result.suggestion).length).toBeGreaterThan(20);
  });
});

describe('read_sheet — schema', () => {
  const schema = () => sheetReadTools.read_sheet.inputSchema as {
    safeParse: (input: unknown) => { success: boolean };
  };

  it('caps a single call at 500 rows so one read cannot flood the context', () => {
    expect(schema().safeParse({ pageId: 'p', limit: 500 }).success).toBe(true);
    expect(schema().safeParse({ pageId: 'p', limit: 501 }).success).toBe(false);
  });

  it('treats startRow as 1-based by rejecting row 0', () => {
    expect(schema().safeParse({ pageId: 'p', startRow: 0 }).success).toBe(false);
    expect(schema().safeParse({ pageId: 'p', startRow: 1 }).success).toBe(true);
  });

  it('accepts columns past ZZZ, which the sheet itself allows', () => {
    expect(schema().safeParse({ pageId: 'p', select: ['ABCDEFG'] }).success).toBe(true);
    expect(schema().safeParse({ pageId: 'p', select: ['ABCDEFGH'] }).success).toBe(false);
  });

  it('advertises the lookup and range capabilities in its description', () => {
    // A capability an agent cannot discover is a capability it does not have —
    // the whole complaint in issue #2467.
    const description = sheetReadTools.read_sheet.description ?? '';
    expect(description).toContain('range');
    expect(description).toContain('where');
    expect(description).toContain('select');
  });
});
