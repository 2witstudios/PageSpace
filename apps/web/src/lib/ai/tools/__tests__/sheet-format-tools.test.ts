/**
 * `format_sheet` and `set_conditional_format`.
 *
 * Every case names the mutation it exists to kill. The store is mocked, but
 * not stubbed to "ok": `applyFormatOps` here runs the real `planFormatOps`
 * over an in-memory tab and keeps the resulting rule and region lists, so a
 * request the tool accepts and the store would refuse fails HERE, and a
 * retried call sees what the first one stored. The spy on it is the atomicity
 * claim in its testable form — a refused request reaches it zero times.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { assert } from './riteway';
import { logSheetCellActivity } from '@/services/api/sheet-activity';
import { broadcastPageEvent } from '@/lib/websocket';
import type * as SheetStore from '@pagespace/lib/sheets/store';
import {
  MAX_CONDITIONAL_RULES,
  parseConditionalRule,
  parseRegion,
  planFormatOps,
  type ConditionalRule,
  type SheetFormatOp,
  type SheetRegion,
} from '@pagespace/lib/sheets/sheet';

/**
 * The tab as the mocked store holds it. `applyFormatOps` below folds each
 * accepted plan back into it, so a second call sees the first one's rules.
 */
interface TabState {
  rowCount: number;
  columnCount: number;
  frozenRows: number | null;
  frozenColumns: number | null;
  columnFormats: Record<string, never>;
  columnWidths: Record<string, never>;
  rowHeights: Record<string, never>;
  conditionalFormats: ConditionalRule[];
  regions: SheetRegion[];
  cellFormats: Record<string, never>;
}

const freshTab = (): TabState => ({
  rowCount: 500,
  columnCount: 16,
  frozenRows: null,
  frozenColumns: null,
  columnFormats: {},
  columnWidths: {},
  rowHeights: {},
  conditionalFormats: [],
  regions: [],
  cellFormats: {},
});

let state: TabState = freshTab();
/** Every ops array the mutator was handed, in order. */
let applied: SheetFormatOp[][] = [];

const mockApplyFormatOps = vi.fn(async (_ref: unknown, ops: readonly SheetFormatOp[]) => {
  const plan = planFormatOps(ops, state);
  applied.push([...ops]);
  state = { ...state, conditionalFormats: [...plan.conditionalFormats], regions: [...plan.regions] };
  for (const step of plan.steps) {
    if (step.type === 'setFrozen') {
      state.frozenRows = step.rows ?? null;
      state.frozenColumns = step.columns ?? null;
    }
  }
  return {
    cellsFormatted: plan.rows.size,
    rowsTouched: plan.rows.size,
    tabFieldsChanged: plan.touchesTabFields ? ['tab'] : [],
    conditionalRules: plan.conditionalFormats.length,
    regions: plan.regions.length,
    rowCount: state.rowCount,
    columnCount: state.columnCount,
    recomputed: [],
  };
});
const mockReadTabFormatting = vi.fn(async () => state);
const mockListTabs = vi.fn();
const mockEnsureTab = vi.fn(async () => ({ id: 'tab-1', ...tabRow }));
const mockGetTab = vi.fn();
const mockReadRows = vi.fn();

vi.mock('@pagespace/lib/sheets/store', () => ({
  applyFormatOps: (...args: Parameters<typeof SheetStore.applyFormatOps>) => mockApplyFormatOps(args[0], args[1]),
  readTabFormatting: (..._args: Parameters<typeof SheetStore.readTabFormatting>) => mockReadTabFormatting(),
  listTabs: (...args: Parameters<typeof SheetStore.listTabs>) => mockListTabs(...args),
  ensureTab: (..._args: Parameters<typeof SheetStore.ensureTab>) => mockEnsureTab(),
  getTab: (...args: Parameters<typeof SheetStore.getTab>) => mockGetTab(...args),
  readRows: (...args: Parameters<typeof SheetStore.readRows>) => mockReadRows(...args),
}));

vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: { findById: vi.fn() },
}));

vi.mock('../actor-permissions', () => ({
  canActorEditPage: vi.fn(),
}));

vi.mock('../page-write-tools', () => ({
  buildAiMutationContext: vi.fn(async () => ({
    userId: 'user-123',
    actorEmail: 'user@example.com',
    isAiGenerated: true,
    aiProvider: 'test',
    aiModel: 'test',
    changeGroupType: 'ai',
  })),
}));

vi.mock('@/services/api/sheet-activity', () => ({
  logSheetCellActivity: vi.fn(async () => undefined),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(async () => undefined),
  createPageEventPayload: vi.fn(() => ({})),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: (id: string) => `***${id?.slice(-4) ?? ''}`,
}));

import {
  MAX_FORMAT_CELLS_PER_CALL,
  MAX_FORMAT_RANGE_CELLS,
  sheetFormatTools,
} from '../sheet-format-tools';
import { MAX_SCHEMA_CHARS } from '../tool-error-schema';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { canActorEditPage } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';

const mockFindById = vi.mocked(pageRepository.findById);
const mockCanEdit = vi.mocked(canActorEditPage);

const sheetPage = {
  id: 'page-1',
  title: 'Budget',
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

const tabRow = { tabIndex: 0, name: 'Sheet1', rowCount: 500, columnCount: 16 };

const context = {
  toolCallId: '1',
  messages: [],
  experimental_context: { userId: 'user-123' } as ToolExecutionContext,
};

type Result = Record<string, unknown>;

const format = (input: Record<string, unknown>) =>
  sheetFormatTools.format_sheet.execute!({ pageId: 'page-1', ...input } as never, context) as unknown as Promise<Result>;
const conditional = (input: Record<string, unknown>) =>
  sheetFormatTools.set_conditional_format.execute!({ pageId: 'page-1', ...input } as never, context) as unknown as Promise<Result>;

const message = (result: Result): string => String(result.message);

beforeEach(() => {
  vi.clearAllMocks();
  state = freshTab();
  applied = [];
  mockFindById.mockResolvedValue({ ...sheetPage });
  mockCanEdit.mockResolvedValue(true);
  mockListTabs.mockResolvedValue([{ id: 'tab-1', pageId: 'page-1', ...tabRow }]);
});

// ---------------------------------------------------------------------------
// format_sheet — the escape hatch's refusal matrix
// ---------------------------------------------------------------------------

describe('format_sheet refuses an op that is wrong across its fields, before any I/O', () => {
  // Kills: an implementation that relies on a zod `.check()`/`.superRefine()`
  // for the cross-field rule. That check does not run when the shape parse
  // fails, and a field-level issue cannot see `clear`, so the op would reach
  // the store with no width and be refused there by a position the model
  // never used — or clamp.
  it('columnWidth with neither width nor clear names ops[0] and the field', async () => {
    const result = await format({ ops: [{ op: 'columnWidth', column: 'C' }] });
    assert({ given: 'a columnWidth op with no width and no clear', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0]');
    expect(message(result)).toContain('"width"');
    expect(message(result)).toContain('"clear"');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: silently ignoring a field the op does not read. The agent that sent
  // `{op: 'freeze', frozenRows: 1, range: 'A1:F1'}` believes it froze AND
  // styled; a tool that froze and dropped the range reports success for half
  // of that.
  it('freeze carrying a range is refused, not half-applied', async () => {
    const result = await format({ ops: [{ op: 'freeze', frozenRows: 1, range: 'A1:F1' }] });
    assert({ given: 'a freeze op with a range', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0]');
    expect(message(result)).toContain('"range"');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: a version that applies each op as it validates it. Without the spy
  // this passes for an implementation that applied two ops and then errored —
  // the sheet is half-styled and the error cannot say which half.
  it('[valid, valid, invalid] reaches the store mutator ZERO times', async () => {
    const result = await format({
      ops: [
        { op: 'setFormat', range: 'A1:F1', format: { bold: true } },
        { op: 'columnWidth', column: 'A', width: 120 },
        { op: 'rowHeight', row: 1 },
      ],
    });
    assert({ given: 'two valid ops followed by an invalid one', should: 'refuse the batch', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[2]');
    assert({
      given: 'a refused batch',
      should: 'never call the store mutator',
      actual: mockApplyFormatOps.mock.calls.length,
      expected: 0,
    });
  });

  // Kills: expanding the range to addresses before checking its size. The
  // count is arithmetic on the corners; the message must carry the index, the
  // count, and the construct that would cost nothing.
  it('A1:Z100000 is refused by count, naming the index and the cheaper construct', async () => {
    const result = await format({ ops: [{ op: 'setFormat', range: 'A1:Z100000', format: { bold: true } }] });
    assert({ given: 'a 2.6 million cell range', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0]');
    expect(message(result)).toContain((26 * 100000).toLocaleString());
    expect(message(result)).toContain(MAX_FORMAT_RANGE_CELLS.toLocaleString());
    expect(message(result)).toContain('columnFormat');
    expect(message(result)).toContain('region');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: a per-op cap with no per-call sum. Each op is exactly at the per-op
  // ceiling, so only the aggregate can refuse — and it must name the op that
  // crossed it, not the first one.
  it('ops that are each within the per-op cap but sum past the per-call cap are refused at the op that crossed', async () => {
    // A1:T1000 is 20 columns x 1,000 rows = 20,000 cells, the per-op maximum.
    const op = { op: 'setFormat', range: 'A1:T1000', format: { italic: true } };
    const result = await format({ ops: [op, op, op] });
    assert({ given: 'three ops of 20,000 cells', should: 'refuse at the third', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[2]');
    expect(message(result)).toContain(MAX_FORMAT_CELLS_PER_CALL.toLocaleString());
    expect(message(result)).toContain('columnFormat');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();

    const twoOps = await format({ ops: [op, op] });
    assert({ given: 'two ops of 20,000 cells', should: 'accept', actual: twoOps.success, expected: true });
  });

  // Kills: accepting `A:A` as a cell range and formatting only `A1` (which is
  // what a lenient address decoder does with a bare column letter).
  it('A:A points the model at columnFormat', async () => {
    const result = await format({ ops: [{ op: 'setFormat', range: 'A:A', format: { bold: true } }] });
    assert({ given: 'a whole-column range', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0]');
    expect(message(result)).toContain('columnFormat');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: forwarding the model's colour verbatim to `cellFormatSchema`, which
  // rejects the short form and would cost a round trip on the commonest
  // spelling there is.
  it('#fff is accepted and stored as #ffffff', async () => {
    const result = await format({ ops: [{ op: 'setFormat', range: 'A1', format: { background: '#fff', color: '#ABC' } }] });
    assert({ given: 'short-form colours', should: 'accept', actual: result.success, expected: true });
    const op = applied[0][0];
    expect(op.type).toBe('setCellFormat');
    assert({
      given: '#fff and #ABC',
      should: 'normalise to six lowercase digits',
      actual: op.type === 'setCellFormat' ? op.patch : null,
      expected: { background: '#ffffff', color: '#aabbcc' },
    });
  });

  it('a colour that is not a colour is refused by name', async () => {
    const result = await format({ ops: [{ op: 'setFormat', range: 'A1', format: { color: 'blueish' } }] });
    assert({ given: 'a word for a colour', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0].format.color');
  });

  it('an empty format is refused rather than applied as a no-op', async () => {
    const result = await format({ ops: [{ op: 'setFormat', range: 'A1', format: {} }] });
    assert({ given: 'a format with no fields', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('ops[0].format');
  });

  it('a freeze naming one axis keeps the other as it is', async () => {
    state.frozenColumns = 2;
    const result = await format({ ops: [{ op: 'freeze', frozenRows: 1 }] });
    assert({ given: 'frozenRows only', should: 'accept', actual: result.success, expected: true });
    assert({
      given: 'a tab with two frozen columns',
      should: 'freeze one row and keep the two columns',
      actual: applied[0][0],
      expected: { type: 'setFrozen', rows: 1, columns: 2 },
    });
  });

  // Kills: resolving an omitted axis from the tab snapshot instead of the
  // running state — the second op would then emit {rows: null, columns: 1}
  // and unfreeze the row the first op had just frozen.
  it('two freeze ops naming one axis each compose, the second keeping the first', async () => {
    const result = await format({
      ops: [
        { op: 'freeze', frozenRows: 1 },
        { op: 'freeze', frozenColumns: 1 },
      ],
    });
    assert({ given: 'freeze rows then freeze columns', should: 'accept', actual: result.success, expected: true });
    assert({
      given: 'a tab with nothing frozen',
      should: 'freeze one row and, in the second op, keep it while freezing one column',
      actual: applied[0],
      expected: [
        { type: 'setFrozen', rows: 1, columns: null },
        { type: 'setFrozen', rows: 1, columns: 1 },
      ],
    });
  });

  // Kills: seeding the running freeze state from the snapshot without the
  // region's freezeHeader — a columns-only op after it would then emit
  // {rows: null, columns: 1} and erase the header rows the region pinned.
  it('a freeze op after a region with freezeHeader keeps the header rows the region pinned', async () => {
    const result = await format({
      regions: [{ range: 'A1:F', headerRows: 2, freezeHeader: true }],
      ops: [{ op: 'freeze', frozenColumns: 1 }],
    });
    assert({ given: 'freezeHeader then a columns-only freeze', should: 'accept', actual: result.success, expected: true });
    const ops = applied[0];
    assert({
      given: 'two header rows pinned by the region',
      should: 'keep those two rows when the op names only columns',
      actual: ops.filter((op) => op.type === 'setFrozen'),
      expected: [
        { type: 'setFrozen', rows: 2, columns: null },
        { type: 'setFrozen', rows: 2, columns: 1 },
      ],
    });
  });

  // Kills: an implementation that threads the state only through the
  // rows/columns branch and leaves `clear` reading the snapshot, so a freeze
  // after a clear would resurrect the axis the clear removed.
  it('a freeze op after clear starts from nothing frozen, not from the snapshot', async () => {
    state.frozenRows = 3;
    state.frozenColumns = 2;
    const result = await format({
      ops: [
        { op: 'freeze', clear: true },
        { op: 'freeze', frozenColumns: 1 },
      ],
    });
    assert({ given: 'clear then freeze columns', should: 'accept', actual: result.success, expected: true });
    assert({
      given: 'a tab with three rows and two columns frozen',
      should: 'clear both, then freeze one column with no rows',
      actual: applied[0],
      expected: [
        { type: 'setFrozen', rows: null, columns: null },
        { type: 'setFrozen', rows: null, columns: 1 },
      ],
    });
  });

  it('a store-side refusal is relabelled with the index the model used', async () => {
    // Column E is outside A1:C — a cross-field problem only the store's
    // planner checks. Its "Op 0 (upsertRegion)" must come back as regions[0].
    const result = await format({
      regions: [{ range: 'A1:C', columns: [{ column: 'E', role: 'currency' }] }],
    });
    assert({ given: 'a region column outside its range', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toMatch(/^regions\[0\]: /);
    expect(message(result)).not.toContain('Op 0');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  it('freezeHeader on a region becomes a freeze of its header rows and is not stored', async () => {
    const result = await format({ regions: [{ range: 'A1:F', headerRows: 2, freezeHeader: true }] });
    assert({ given: 'a region with freezeHeader', should: 'accept', actual: result.success, expected: true });
    const ops = applied[0];
    expect(ops[0].type).toBe('upsertRegion');
    expect((ops[0] as { region: SheetRegion }).region).not.toHaveProperty('freezeHeader');
    assert({ given: 'two header rows', should: 'freeze two rows', actual: ops[1], expected: { type: 'setFrozen', rows: 2, columns: null } });
  });

  it('freezeHeader on a region that does not start at row 1 is refused', async () => {
    const result = await format({ regions: [{ range: 'A5:F', freezeHeader: true }] });
    assert({ given: 'freezeHeader on a region starting at row 5', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('regions[0]');
    expect(message(result)).toContain('row 5');
  });

  it('nothing to apply is a refusal, not a silent success', async () => {
    const result = await format({});
    assert({ given: 'neither regions nor ops', should: 'refuse', actual: result.success, expected: false });
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Shared page/tab refusals
// ---------------------------------------------------------------------------

describe('both tools locate the tab the same way', () => {
  it('checks permission BEFORE the page type, so a wrong-type refusal cannot leak a title', async () => {
    mockFindById.mockResolvedValue({ ...sheetPage, type: 'DOCUMENT' as never, title: 'Q3 Layoffs' });
    mockCanEdit.mockResolvedValue(false);
    await expect(format({ ops: [{ op: 'freeze', frozenRows: 1 }] })).rejects.toThrow(/Insufficient permissions/);
    await expect(conditional({ rules: [{ kind: 'dataBar', ranges: ['A1'], color: '#3b82f6' }] })).rejects.toThrow(
      /Insufficient permissions/
    );
  });

  it('refuses a page that is not a sheet', async () => {
    mockFindById.mockResolvedValue({ ...sheetPage, type: 'DOCUMENT' as never });
    const result = await format({ ops: [{ op: 'freeze', frozenRows: 1 }] });
    assert({ given: 'a DOCUMENT page', should: 'refuse', actual: result.error, expected: 'Page is not a sheet' });
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: materialising first and asking questions later. A SHEET page
  // holding text materialises to an EMPTY tab and the text is gone from every
  // read path; the probe has to be a pure read that runs before `ensureTab`.
  it('refuses to format a SHEET page whose content is text, without materialising it', async () => {
    mockListTabs.mockResolvedValue([]);
    mockFindById.mockResolvedValue({ ...sheetPage, content: 'Notes from the offsite, not a spreadsheet.' });
    const result = await format({ ops: [{ op: 'freeze', frozenRows: 1 }] });
    assert({ given: 'text on a SHEET page', should: 'refuse', actual: result.error, expected: 'Page holds text, not a spreadsheet' });
    expect(mockEnsureTab).not.toHaveBeenCalled();
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  it('a tab that does not exist is refused with the tabs that do', async () => {
    mockListTabs.mockResolvedValue([
      { id: 'tab-1', pageId: 'page-1', ...tabRow },
      { id: 'tab-2', pageId: 'page-1', tabIndex: 1, name: 'Forecast', rowCount: 10, columnCount: 4 },
    ]);
    const result = await conditional({ tabIndex: 7, rules: [{ kind: 'dataBar', ranges: ['A1'], color: '#3b82f6' }] });
    assert({ given: 'tabIndex 7 on a two-tab sheet', should: 'refuse', actual: result.error, expected: 'Sheet tab not found' });
    expect(message(result)).toContain('0 ("Sheet1")');
    expect(message(result)).toContain('1 ("Forecast")');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// set_conditional_format
// ---------------------------------------------------------------------------

describe('set_conditional_format', () => {
  // Kills: passing the condition straight through. `between` with one bound
  // is stored, valid-looking, and matches nothing.
  it('between without value2 is refused naming rules[0] and value2', async () => {
    const result = await conditional({
      rules: [{ kind: 'cell', ranges: ['C2:C40'], operator: 'between', value: 10, format: { bold: true } }],
    });
    assert({ given: 'between with one bound', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('rules[0]');
    expect(message(result)).toContain('value2');
    // Before ANY I/O — not even the page lookup. The store's planner refuses
    // the same rule after the tab has been read, so without this line the
    // tool's own check could be deleted and every assertion above would hold.
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  it('isEmpty with a value is accepted, the value dropped and said', async () => {
    const result = await conditional({
      rules: [{ kind: 'cell', ranges: ['C2:C40'], operator: 'isEmpty', value: '', format: { background: '#fee2e2' } }],
    });
    assert({ given: 'isEmpty with a value', should: 'accept', actual: result.success, expected: true });
    const op = applied[0][0];
    expect(op.type).toBe('addConditionalRule');
    const rule = (op as { rule: ConditionalRule }).rule;
    expect(rule.kind).toBe('cell');
    if (rule.kind === 'cell') {
      assert({ given: 'the stored condition', should: 'carry no value', actual: rule.condition, expected: { operator: 'isEmpty' } });
    }
    expect(String((result.warnings as string[])[0])).toContain('rules[0]');
  });

  it('a number operand is accepted and stored as text', async () => {
    await conditional({
      rules: [{ kind: 'cell', ranges: ['C2:C40'], operator: 'greaterThan', value: 5, format: { bold: true } }],
    });
    const rule = (applied[0][0] as { rule: ConditionalRule }).rule;
    if (rule.kind === 'cell') expect(rule.condition.value).toBe('5');
  });

  it('a field belonging to another kind is refused, not stored inert', async () => {
    const result = await conditional({
      rules: [{ kind: 'colorScale', ranges: ['C2:C40'], min: { type: 'min', color: '#fee2e2' }, max: { type: 'max', color: '#15803d' }, format: { bold: true } }],
    });
    assert({ given: 'format on a colorScale', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('rules[0]');
    expect(message(result)).toContain('"format"');
  });

  // Kills: checking the cap against the request alone, or quoting the limit
  // without the current count — the model needs both to decide what to remove.
  it('adding 20 rules to a tab holding 195 is refused quoting 195 and 200', async () => {
    state.conditionalFormats = Array.from({ length: 195 }, (_, index) => ({
      id: `rule-${index}`,
      kind: 'dataBar' as const,
      ranges: [`A${index + 1}`],
      color: '#3b82f6',
    }));
    const rules = Array.from({ length: 20 }, (_, index) => ({
      kind: 'cell',
      ranges: [`B${index + 1}`],
      operator: 'greaterThan',
      value: String(index),
      format: { bold: true },
    }));
    const result = await conditional({ rules });
    assert({ given: '195 + 20 rules', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('195');
    expect(message(result)).toContain(String(MAX_CONDITIONAL_RULES));
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  // Kills: minting a fresh id per call with no content check. A retry after a
  // timeout is routine, and it would double every rule.
  it('an identical call repeated adds one rule, not two', async () => {
    const input = {
      rules: [
        { kind: 'cell', ranges: ['C2:C40'], operator: 'greaterThan', value: '1000', format: { bold: true, color: '#b91c1c' } },
        { kind: 'dataBar', ranges: ['D2:D40'], color: '#3b82f6' },
      ],
    };
    const first = await conditional(input);
    const second = await conditional(input);
    assert({ given: 'the first call', should: 'add two', actual: first.added, expected: 2 });
    assert({ given: 'the repeated call', should: 'add none', actual: second.added, expected: 0 });
    assert({ given: 'the repeated call', should: 'return the same ids', actual: second.ruleIds, expected: first.ruleIds });
    assert({ given: 'both calls', should: 'leave two rules on the tab', actual: state.conditionalFormats.length, expected: 2 });
    assert({ given: 'the repeated call', should: 'not reach the mutator', actual: mockApplyFormatOps.mock.calls.length, expected: 1 });
  });

  // Kills: deduping by content only BEFORE the call. A timeout retry that
  // overlaps the original reads a snapshot without the rule, sees no
  // duplicate, mints a fresh id, and the store — which replans under its tab
  // lock — is the only place that can catch it. Also kills: the tool
  // surfacing the store's content refusal as a failure, or re-adding after it;
  // to the model this IS a landed retry, and the answer is the same success
  // shape the pre-flight dedupe returns.
  it('an in-flight retry whose rule landed between the read and the write reports it as already there', async () => {
    const snapshotBeforeLanding = freshTab();
    mockReadTabFormatting.mockResolvedValueOnce(snapshotBeforeLanding);
    state.conditionalFormats = [
      {
        id: 'rule-landed',
        kind: 'cell',
        ranges: ['C2:C40'],
        condition: { operator: 'greaterThan', value: '1000' },
        format: { bold: true, color: '#b91c1c' },
      },
    ];
    const result = await conditional({
      rules: [{ kind: 'cell', ranges: ['C2:C40'], operator: 'greaterThan', value: '1000', format: { bold: true, color: '#b91c1c' } }],
    });
    assert({ given: 'a retry racing the original', should: 'succeed', actual: result.success, expected: true });
    assert({ given: 'a retry racing the original', should: 'add nothing', actual: result.added, expected: 0 });
    assert({ given: 'a retry racing the original', should: 'return the landed id', actual: result.ruleIds, expected: ['rule-landed'] });
    assert({
      given: 'a retry racing the original',
      should: 'report the duplicate by index',
      actual: result.skippedDuplicates,
      expected: [{ index: 0, existingRuleId: 'rule-landed' }],
    });
    assert({ given: 'the tab after', should: 'hold exactly one rule', actual: state.conditionalFormats.length, expected: 1 });
    // The mutator was reached once — that is the race — and refused under the
    // lock rather than storing a twin.
    assert({ given: 'the mutator', should: 'be called once', actual: mockApplyFormatOps.mock.calls.length, expected: 1 });
  });

  // Kills: treating EVERY content refusal from the store as "landed". A rule
  // that some other writer added while this one was in flight explains one
  // rule of the call, not the rest — reporting success would tell the model
  // the second rule is on the tab when nothing was written.
  it('a store content refusal that does not account for every rule in the call is a refusal', async () => {
    mockReadTabFormatting.mockResolvedValueOnce(freshTab());
    state.conditionalFormats = [{ id: 'rule-other', kind: 'dataBar', ranges: ['D2:D40'], color: '#3b82f6' }];
    const result = await conditional({
      rules: [
        { kind: 'dataBar', ranges: ['D2:D40'], color: '#3b82f6' },
        { kind: 'cell', ranges: ['C2:C40'], operator: 'greaterThan', value: '1000', format: { bold: true } },
      ],
    });
    assert({ given: 'one twin and one new rule', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('rules[0]');
    expect(message(result)).toContain('"rule-other"');
    assert({ given: 'the tab after', should: 'hold only the other writer’s rule', actual: state.conditionalFormats.length, expected: 1 });
  });

  it('removeRuleIds naming an absent id lists the ids that exist', async () => {
    state.conditionalFormats = [
      { id: 'rule-a', kind: 'dataBar', ranges: ['A1'], color: '#3b82f6' },
      { id: 'rule-b', kind: 'dataBar', ranges: ['A2'], color: '#3b82f6' },
    ];
    const result = await conditional({ removeRuleIds: ['rule-zzz'] });
    assert({ given: 'an unknown id', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('removeRuleIds[0]');
    expect(message(result)).toContain('"rule-a"');
    expect(message(result)).toContain('"rule-b"');
    expect(mockApplyFormatOps).not.toHaveBeenCalled();
  });

  it('format_sheet: retrying a new-region call is idempotent — the twin reuses the existing id', async () => {
    // A region declared without an id gets a minted one. The same call
    // retried after a timed-out response used to mint a second id and land a
    // content-identical, overlapping twin on every attempt.
    const region = { range: 'A1:D', headerRows: 1, name: 'Orders', columns: [{ column: 'C', role: 'currency' as const }] };
    const first = await format({ regions: [region] });
    assert({ given: 'the first call', should: 'declare one region', actual: state.regions.length, expected: 1 });
    const second = await format({ regions: [region] });
    assert({ given: 'the identical call again', should: 'still succeed', actual: second.success, expected: true });
    assert({ given: 'the tab after the retry', should: 'hold ONE region', actual: state.regions.length, expected: 1 });
    assert({
      given: 'the retry',
      should: 'report the id the first call minted',
      actual: (second as { regionIds?: string[] }).regionIds,
      expected: (first as { regionIds?: string[] }).regionIds,
    });
    const changed = await format({ regions: [{ ...region, theme: 'blue' }] });
    assert({ given: 'a different region', should: 'still get its own id', actual: state.regions.length, expected: 2 });
    expect(changed.success).toBe(true);
  });

  it('a region declared without an id gets the SAME id on every execution, even with no twin in the snapshot', async () => {
    // Two overlapping executions of a retried call are both planned before
    // either commits, so neither snapshot shows the other's region. Only a
    // content-derived id makes the store's upsert-by-id absorb the second.
    const region = { range: 'A1:D', headerRows: 1, name: 'Orders' };
    const first = (await format({ regions: [region] })) as { regionIds?: string[] };
    state = freshTab(); // as if the first commit is not visible yet
    const again = (await format({ regions: [region] })) as { regionIds?: string[] };
    assert({ given: 'the same declaration on an empty snapshot', should: 'mint the same id', actual: again.regionIds, expected: first.regionIds });
    state = freshTab();
    const other = (await format({ regions: [{ ...region, name: 'Invoices' }] })) as { regionIds?: string[] };
    expect(other.regionIds).not.toEqual(first.regionIds);
  });

  it('a call that changed nothing logs no activity and broadcasts nothing', async () => {
    // The store reports a no-op (a bold that was already bold, a retry) with
    // rowsTouched 0 and no tab field changed, and bumps no revision. The tool
    // must not turn that into an activity entry, a workflow trigger and a
    // content-updated broadcast.
    mockApplyFormatOps.mockImplementationOnce(async () => ({
      cellsFormatted: 0,
      rowsTouched: 0,
      tabFieldsChanged: [],
      conditionalRules: 0,
      regions: 0,
      rowCount: 500,
      columnCount: 16,
      recomputed: [],
    }));
    const noop = await format({ ops: [{ op: 'setFormat', range: 'A1', format: { bold: true } }] });
    assert({ given: 'a no-op format', should: 'still succeed', actual: noop.success, expected: true });
    assert({ given: 'a no-op format', should: 'report changed: false', actual: (noop as { changed?: boolean }).changed, expected: false });
    expect(message(noop)).toContain('already had this formatting');
    expect(vi.mocked(logSheetCellActivity)).not.toHaveBeenCalled();
    expect(vi.mocked(broadcastPageEvent)).not.toHaveBeenCalled();

    const real = await format({ ops: [{ op: 'setFormat', range: 'A1', format: { bold: true } }] });
    assert({ given: 'a format that changed a row', should: 'succeed', actual: real.success, expected: true });
    assert({ given: 'a real change', should: 'report changed: true', actual: (real as { changed?: boolean }).changed, expected: true });
    expect(vi.mocked(logSheetCellActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcastPageEvent)).toHaveBeenCalledTimes(1);
  });

  it('format_sheet: replaceAll with an empty region list clears every region', async () => {
    // Mirrors the rule case below. The nothing-given guard used to fire
    // first, so the documented "keep only these" could not express "none".
    state.regions = [{ id: 'orders', range: 'A1:D', headerRows: 1 } as SheetRegion];
    const result = await format({ regionMode: 'replaceAll', regions: [] });
    assert({ given: 'replaceAll with nothing', should: 'accept', actual: result.success, expected: true });
    assert({ given: 'the tab after', should: 'hold no regions', actual: state.regions.length, expected: 0 });
    expect(message(result)).toContain('every other region on the tab removed');
    const bare = await format({});
    assert({ given: 'no regions, no ops, no mode', should: 'still refuse', actual: bare.success, expected: false });
  });

  it('replaceAll with an empty list clears every rule', async () => {
    state.conditionalFormats = [{ id: 'rule-a', kind: 'dataBar', ranges: ['A1'], color: '#3b82f6' }];
    const result = await conditional({ mode: 'replaceAll', rules: [] });
    assert({ given: 'replaceAll with nothing', should: 'accept', actual: result.success, expected: true });
    assert({ given: 'the tab after', should: 'hold no rules', actual: state.conditionalFormats.length, expected: 0 });
  });

  it('a rule kind missing its required field is refused by name', async () => {
    const result = await conditional({ rules: [{ kind: 'formula', ranges: ['A1:A9'], format: { bold: true } }] });
    assert({ given: 'a formula rule with no formula', should: 'refuse', actual: result.success, expected: false });
    expect(message(result)).toContain('rules[0]');
    expect(message(result)).toContain('"formula"');
  });
});

// ---------------------------------------------------------------------------
// Property: what the tool accepts, the parser keeps
// ---------------------------------------------------------------------------

/**
 * A small deterministic generator. Anything the tool ACCEPTS but the stored
 * parser drops or rewrites DISAPPEARS on the next load — the failure that
 * looks like success from every direction. Four hand-picked examples prove
 * four examples; this walks combinations across every kind and field.
 */
const rng = (seed: number) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
};
const pick = <T,>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];
const maybe = <T,>(random: () => number, value: T): T | undefined => (random() < 0.5 ? value : undefined);
const strip = (object: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const COLOURS = ['#fff', '#ABC', '#1d4ed8', '#FEE2E2', '#15803d'];
const FORMATS = () => [
  { bold: true },
  { background: pick(rng(1), COLOURS), color: pick(rng(2), COLOURS) },
  { italic: true, number: { kind: 'currency', currency: 'usd', decimals: 2 } },
  { align: 'right', fontSize: 12, fontFamily: 'mono' },
];

describe('every rule and region the tool accepts survives its parser unchanged', () => {
  it('rules, across all four kinds', async () => {
    const random = rng(42);
    let accepted = 0;
    for (let sample = 0; sample < 120; sample++) {
      const kind = pick(random, ['cell', 'formula', 'colorScale', 'dataBar'] as const);
      const ranges = [pick(random, ['A1:A100', 'B2:D40', 'C7', 'a1:f20'])];
      const format = pick(random, FORMATS());
      const anchor = (needsColour: boolean) => {
        const type = pick(random, ['min', 'max', 'number', 'percent', 'percentile'] as const);
        return strip({
          type,
          value: type === 'min' || type === 'max' ? undefined : type === 'number' ? Math.floor(random() * 100) : Math.floor(random() * 100),
          color: needsColour ? pick(random, COLOURS) : undefined,
        });
      };
      const rule =
        kind === 'cell'
          ? (() => {
              const operator = pick(random, [
                'greaterThan', 'lessThanOrEqual', 'equal', 'notEqual', 'between', 'notBetween',
                'contains', 'startsWith', 'isEmpty', 'isNotEmpty', 'isError',
              ] as const);
              const numeric = ['greaterThan', 'lessThanOrEqual', 'between', 'notBetween'].includes(operator);
              return strip({
                kind, ranges, operator, format,
                value: numeric ? pick(random, [5, '12.5', 0]) : pick(random, ['done', 'x', '3']),
                value2: numeric ? pick(random, [50, '99']) : maybe(random, 'ignored'),
              });
            })()
          : kind === 'formula'
            ? { kind, ranges, format, formula: pick(random, ['=A1>5', 'SUM(A1:A3)>0', '=B2<>""']) }
            : kind === 'colorScale'
              ? strip({ kind, ranges, min: anchor(true), max: anchor(true), mid: maybe(random, anchor(true)) })
              : strip({ kind, ranges, color: pick(random, COLOURS), min: maybe(random, anchor(false)), max: maybe(random, anchor(false)) });

      state = freshTab();
      applied = [];
      const result = await conditional({ rules: [rule] });
      if (result.success !== true) continue;
      accepted++;

      const op = applied[0][0];
      expect(op.type).toBe('addConditionalRule');
      const stored = (op as { rule: unknown }).rule;
      const reparsed = parseConditionalRule(JSON.parse(JSON.stringify(stored)));
      expect(reparsed, `sample ${sample}: ${JSON.stringify(rule)}`).toEqual(stored);
    }
    // Enough acceptances that the walk covered every kind several times over;
    // a tool that refused most of the space would prove nothing here.
    expect(accepted).toBeGreaterThan(80);
  });

  it('regions, across roles, themes, totals and headers', async () => {
    const random = rng(7);
    let accepted = 0;
    for (let sample = 0; sample < 80; sample++) {
      const open = random() < 0.5;
      const range = open ? 'A1:F' : `A1:F${20 + Math.floor(random() * 30)}`;
      const headerRows = maybe(random, Math.floor(random() * 3));
      const region = strip({
        range,
        headerRows,
        name: maybe(random, pick(random, ['Budget', '  Spend  ', 'Q3'])),
        totalRows: maybe(random, [19, 18, 19].slice(0, 1 + Math.floor(random() * 3))),
        columns: maybe(random, [
          strip({ column: pick(random, ['b', 'C', 'f']), role: 'currency', currency: maybe(random, 'eur'), decimals: maybe(random, 0) }),
          strip({ column: 'D', role: pick(random, ['percent', 'number', 'date', 'text', 'id', 'datetime'] as const), decimals: undefined }),
        ]),
        theme: maybe(random, pick(random, ['blue', 'green', 'slate', 'amber'])),
        freezeHeader: maybe(random, true),
      });

      state = freshTab();
      applied = [];
      const result = await format({ regions: [region] });
      if (result.success !== true) continue;
      accepted++;

      const op = applied[0][0];
      expect(op.type).toBe('upsertRegion');
      const stored = (op as { region: unknown }).region;
      const reparsed = parseRegion(JSON.parse(JSON.stringify(stored)));
      expect(reparsed, `sample ${sample}: ${JSON.stringify(region)}`).toEqual(stored);
    }
    expect(accepted).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

describe('the input schemas stay flat and small', () => {
  // Kills: someone later "tidying" the flat op into a discriminated union —
  // which fans out to anyOf with N copies of the format sub-schema, blows the
  // parameter-error budget, and is rejected outright by some providers.
  it.each([
    ['format_sheet', sheetFormatTools.format_sheet.inputSchema],
    ['set_conditional_format', sheetFormatTools.set_conditional_format.inputSchema],
  ])('%s serialises under MAX_SCHEMA_CHARS with no top-level $ref/anyOf', (_name, schema) => {
    const rendered = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any', cycles: 'ref' }) as Record<string, unknown>;
    const serialised = JSON.stringify(rendered);
    expect(serialised.length, `${serialised.length} chars`).toBeLessThan(MAX_SCHEMA_CHARS);
    expect(rendered).not.toHaveProperty('$ref');
    expect(rendered).not.toHaveProperty('anyOf');
    expect(rendered).not.toHaveProperty('oneOf');
    expect(rendered).not.toHaveProperty('$defs');

    // And the array items are one object each, not a union of shapes.
    const properties = rendered.properties as Record<string, Record<string, unknown>>;
    for (const key of ['ops', 'regions', 'rules']) {
      const items = properties[key]?.items as Record<string, unknown> | undefined;
      if (!items) continue;
      expect(items.type, `${key}.items`).toBe('object');
      expect(items).not.toHaveProperty('anyOf');
      expect(items).not.toHaveProperty('oneOf');
    }
  });

  it('the AI-facing format carries no borders and no custom number kind', () => {
    const rendered = z.toJSONSchema(sheetFormatTools.format_sheet.inputSchema as z.ZodType) as unknown as {
      properties: { ops: { items: { properties: { format: { properties: Record<string, unknown> } } } } };
    };
    const format = rendered.properties.ops.items.properties.format.properties;
    expect(format).not.toHaveProperty('borders');
    const number = format.number as { properties: { kind: { enum: string[] }; pattern?: unknown } };
    expect(number.properties.kind.enum).not.toContain('custom');
    expect(number.properties).not.toHaveProperty('pattern');
  });
});
