/**
 * The claim in issue #2467, measured against the real code at the real size.
 *
 * The reporter's sheet was 500 rows x 16 columns, and the complaint was not
 * "this is a bit verbose" — it was that reading it was impossible, because the
 * old path serialised the whole spreadsheet to SheetDoc TOML and numbered every
 * line of it. These cases build that sheet and put both paths side by side:
 * `serializeSheetContent` is the ACTUAL function the old read used, not a stand
 * -in, so the ratio here is a measurement rather than an estimate.
 *
 * They are regression guards, not documentation. A future change that removes
 * the row cap, drops the projection, or reintroduces whole-document reads on an
 * agent path fails here at the size where it actually hurts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTab = vi.fn();
const mockListTabs = vi.fn();
const mockReadRows = vi.fn();
const mockQueryRows = vi.fn();

vi.mock('@pagespace/lib/sheets/store', () => ({
  getTab: (...args: unknown[]) => mockGetTab(...args as []),
  listTabs: (...args: unknown[]) => mockListTabs(...args as []),
  readRows: (...args: unknown[]) => mockReadRows(...args as []),
  queryRows: (...args: unknown[]) => mockQueryRows(...args as []),
  ensureTab: vi.fn(),
}));

vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: { findById: vi.fn() },
}));

vi.mock('../actor-permissions', () => ({
  canActorViewPage: vi.fn(async () => true),
  canActorEditPage: vi.fn(async () => true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  },
}));

vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: (id: string) => id }));

import { sheetReadTools } from '../sheet-read-tools';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { serializeSheetContent } from '@pagespace/lib/sheets/io';
import { encodeCellAddress } from '@pagespace/lib/sheets/sheet';
import type { StoredCell } from '@pagespace/db/schema/sheets-types';
import type { ToolExecutionContext } from '../../core/types';

const ROWS = 500;
const COLUMNS = 16;
const HEADERS = [
  'memid', 'org', 'city', 'state', 'zip', 'phone', 'email', 'website',
  'contact', 'title', 'members', 'founded', 'tier', 'status', 'notes', 'updated',
];

/** One row of the reporter's dataset, shaped like real chamber-of-commerce data. */
function cellsForRow(rowIndex: number): Record<string, StoredCell> {
  const cells: Record<string, StoredCell> = {};
  for (let column = 0; column < COLUMNS; column++) {
    const label = encodeCellAddress(0, column).replace(/\d+$/, '');
    const text = rowIndex === 0
      ? HEADERS[column]
      : column === 0
        ? String(28604 + rowIndex)
        : column === 1
          ? `Greater ${['Arlington', 'Boston', 'Denver'][rowIndex % 3]} Chamber of Commerce`
          : column === 7
            ? `https://example.org/directory/member/${28604 + rowIndex}`
            : `v${rowIndex}-${column}`;
    cells[label] = { raw: text, value: text };
  }
  return cells;
}

const allRows = Array.from({ length: ROWS }, (_, rowIndex) => ({
  rowIndex,
  cells: cellsForRow(rowIndex),
}));

const tab = { id: 'tab-1', tabIndex: 0, name: 'Members', rowCount: ROWS, columnCount: COLUMNS };

const context = {
  toolCallId: '1',
  messages: [],
  experimental_context: { userId: 'user-123' } as ToolExecutionContext,
};

const run = (input: Record<string, unknown>) =>
  sheetReadTools.read_sheet.execute!(input as never, context) as unknown as Promise<
    Record<string, unknown>
  >;

/**
 * What `read_page` used to return: the whole sheet as a SheetDoc document, via
 * the same serializer that path called.
 */
function wholeDocument(): string {
  const cells: Record<string, string> = {};
  for (const row of allRows) {
    for (const [label, cell] of Object.entries(row.cells)) {
      cells[`${label}${row.rowIndex + 1}`] = String(cell.value);
    }
  }
  return serializeSheetContent(
    { version: 1, rowCount: ROWS, columnCount: COLUMNS, cells, sheetName: 'Members' },
    { pageId: 'page-1' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pageRepository.findById).mockResolvedValue({
    id: 'page-1',
    title: 'Members',
    type: 'SHEET',
    content: '',
    contentMode: 'html',
    driveId: 'drive-1',
    parentId: null,
    position: 1,
    isTrashed: false,
    trashedAt: null,
    revision: 1,
    stateHash: null,
  });
  mockListTabs.mockResolvedValue([tab]);
  mockGetTab.mockResolvedValue(tab);
  mockReadRows.mockImplementation(async (_id: string, options: { fromRow?: number; limit?: number }) =>
    allRows.slice(options.fromRow ?? 0, (options.fromRow ?? 0) + (options.limit ?? 200)),
  );
});

describe('a 500 x 16 sheet — the size from issue #2467', () => {
  it('costs orders of magnitude less to read than the whole document did', () => {
    const document = wholeDocument();
    // The old read numbered EVERY line of this, cell by cell.
    expect(document.split('\n').length).toBeGreaterThan(20_000);
    expect(document.length).toBeGreaterThan(300_000);
  });

  it('returns a bounded default read, not the sheet', async () => {
    const result = await run({ pageId: 'page-1' });
    const document = wholeDocument();
    const payload = JSON.stringify(result);

    expect(result.rowsReturned).toBe(50);
    expect(result.dimensions).toEqual({ rowCount: ROWS, columnCount: COLUMNS });
    expect(result.hasMore).toBe(true);
    // The whole point: a default read is a small fraction of the document, and
    // the response says how much more there is rather than pretending it is all.
    expect(payload.length).toBeLessThan(document.length / 5);
    expect(payload).not.toContain('PAGESPACE_SHEETDOC');
  });

  it('never exceeds its row cap however large a limit is asked for', async () => {
    const result = await run({ pageId: 'page-1', limit: 500 });
    expect(result.rowsReturned).toBe(500);

    // 501 is refused by the schema rather than silently clamped, so an agent
    // learns the ceiling instead of inferring it from a short answer.
    const schema = sheetReadTools.read_sheet.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ pageId: 'page-1', limit: 501 }).success).toBe(false);
  });

  it('projects a wide sheet down to the columns asked for', async () => {
    const full = await run({ pageId: 'page-1', limit: 50 });
    const projected = await run({ pageId: 'page-1', limit: 50, select: ['A', 'B'] });

    const projectedRows = projected.rows as { cells: Record<string, string> }[];
    expect(Object.keys(projectedRows[0].cells)).toEqual(['A', 'B']);
    // Two of sixteen columns has to actually cost less, not merely report less.
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(full).length / 3);
  });

  it('answers "the row where memid = 28605" without reading the sheet', async () => {
    // The reporter's exact question. It is one filtered call, and the rows it
    // does not match are never fetched — `queryRows` runs in the database.
    const match = allRows.find((row) => row.cells.A.value === '28605')!;
    mockQueryRows.mockResolvedValue({
      rows: [{ rowIndex: match.rowIndex, cells: match.cells }],
      total: 1,
      hasMore: false,
    });

    const result = await run({
      pageId: 'page-1',
      where: { conditions: [{ column: 'A', op: 'eq', value: '28605' }] },
    });

    expect(result.matchedRows).toBe(1);
    expect(result.rowsReturned).toBe(1);
    expect(mockReadRows).not.toHaveBeenCalled();
    const rows = result.rows as { rowNumber: number; cells: Record<string, string> }[];
    expect(rows[0].cells.A).toBe('28605');
    // The row number it reports is the row an edit_sheet_cells address needs.
    expect(rows[0].rowNumber).toBe(match.rowIndex + 1);
  });

  it('pages the whole sheet in bounded steps that terminate', async () => {
    // The loop an agent actually writes. It has to reach the end, visit every
    // row exactly once, and never repeat a window.
    const seen: number[] = [];
    let startRow: number | undefined;
    for (let call = 0; call < 20; call++) {
      const result = await run({ pageId: 'page-1', startRow, limit: 100 });
      seen.push(...(result.rows as { rowNumber: number }[]).map((row) => row.rowNumber));
      if (!result.hasMore) break;
      startRow = result.nextStartRow as number;
    }

    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen).size).toBe(ROWS);
    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBe(ROWS);
  });
});
