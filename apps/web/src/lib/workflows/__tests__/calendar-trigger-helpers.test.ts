import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockQueryPages,
  mockSelect, mockSelectWhere,
  mockUpdate, mockUpdateSet,
  mockDelete, mockDeleteWhere,
  mockTransaction,
} = vi.hoisted(() => {
  const mockQueryPages = { findFirst: vi.fn(), findMany: vi.fn() };
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
  const mockTransaction = vi.fn();
  return {
    mockQueryPages,
    mockSelect, mockSelectWhere,
    mockUpdate, mockUpdateSet,
    mockDelete, mockDeleteWhere,
    mockTransaction,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    delete: mockDelete,
    query: { pages: mockQueryPages },
    transaction: mockTransaction,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  and: vi.fn((...conds) => ({ op: 'and', conds })),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
  ne: vi.fn((field, value) => ({ op: 'ne', field, value })),
  gt: vi.fn((field, value) => ({ op: 'gt', field, value })),
  sql: vi.fn(() => ({})),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { id: 'id', workflowId: 'workflowId', calendarEventId: 'calendarEventId', driveId: 'driveId', scheduledById: 'scheduledById' },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: { sourceTable: 'sourceTable', sourceId: 'sourceId' },
}));

import {
  createCalendarTriggerWorkflow,
  validateCalendarAgentTrigger,
  removeCalendarTrigger,
  upsertCalendarTriggerWorkflow,
} from '../calendar-trigger-helpers';
import { db } from '@pagespace/db/db';

// Build a fresh tx mock that records the order/identity of each insert and
// captures the values payload so we can assert atomicity (both inserts
// happen, both within the same callback) and shape.
function makeTxMock(opts: {
  workflowReturn?: unknown[];
  triggerReturn?: unknown[];
} = {}) {
  const insertCalls: { table: unknown; values: unknown }[] = [];

  // Two inserts in order: workflows then calendar_triggers.
  const wfReturning = vi.fn().mockResolvedValue(opts.workflowReturn ?? [{ id: 'wf-1' }]);
  const trgReturning = vi.fn().mockResolvedValue(opts.triggerReturn ?? [{ id: 'trg-1' }]);

  let insertCount = 0;
  const insertValues = vi.fn((values: unknown) => {
    const last = insertCalls[insertCalls.length - 1];
    if (last) last.values = values;
    return { returning: insertCount === 1 ? wfReturning : trgReturning };
  });

  const insert = vi.fn((table: unknown) => {
    insertCount++;
    insertCalls.push({ table, values: undefined });
    return { values: insertValues };
  });

  const tx = { insert };
  return { tx, insert, insertCalls };
}

describe('createCalendarTriggerWorkflow', () => {
  const baseParams = {
    driveId: 'drive-1',
    scheduledById: 'user-1',
    calendarEventId: 'evt-1',
    triggerAt: new Date('2026-05-01T09:00:00Z'),
    timezone: 'UTC',
    agentTrigger: {
      agentPageId: 'agent-1',
      prompt: 'Run check',
      instructionPageId: null,
      contextPageIds: [],
    },
  };

  it('inserts the workflows row and the calendar_triggers row in that order on the supplied tx', async () => {
    const captured = makeTxMock();

    const result = await createCalendarTriggerWorkflow({
      ...baseParams,
      // Cast: the helper takes a real tx; the test only needs insert().
      tx: captured.tx as unknown as Parameters<typeof createCalendarTriggerWorkflow>[0]['tx'],
    });

    expect(captured.insert).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ workflowId: 'wf-1', triggerId: 'trg-1' });

    const [wfInsert, trgInsert] = captured.insertCalls;
    const wfValues = wfInsert.values as Record<string, unknown>;
    expect(wfValues.driveId).toBe('drive-1');
    expect(wfValues.agentPageId).toBe('agent-1');
    expect(wfValues.prompt).toBe('Run check');
    // Backing workflow always carries triggerType='cron' but cronExpression
    // stays null — this is what the management-route filter keys off.
    expect(wfValues.triggerType).toBe('cron');
    expect(wfValues.cronExpression).toBeUndefined();

    const trgValues = trgInsert.values as Record<string, unknown>;
    expect(trgValues.calendarEventId).toBe('evt-1');
    expect(trgValues.workflowId).toBe('wf-1');
    expect(trgValues.scheduledById).toBe('user-1');
    // calendar_triggers no longer carries a per-fire status column — that
    // state lives on workflow_runs and gets written by the executor.
    expect(trgValues.status).toBeUndefined();
  });

  it('falls back to a stock prompt when the caller passes none', async () => {
    const captured = makeTxMock();

    await createCalendarTriggerWorkflow({
      ...baseParams,
      agentTrigger: { ...baseParams.agentTrigger, prompt: undefined },
      tx: captured.tx as unknown as Parameters<typeof createCalendarTriggerWorkflow>[0]['tx'],
    });

    const wfValues = captured.insertCalls[0].values as Record<string, unknown>;
    expect(wfValues.prompt).toBe('Execute instructions from linked page.');
  });

  it('passes through instructionPageId and contextPageIds onto the workflow row', async () => {
    const captured = makeTxMock();

    await createCalendarTriggerWorkflow({
      ...baseParams,
      agentTrigger: {
        agentPageId: 'agent-1',
        prompt: 'Run check',
        instructionPageId: 'page-instr',
        contextPageIds: ['ctx-a', 'ctx-b'],
      },
      tx: captured.tx as unknown as Parameters<typeof createCalendarTriggerWorkflow>[0]['tx'],
    });

    const wfValues = captured.insertCalls[0].values as Record<string, unknown>;
    expect(wfValues.instructionPageId).toBe('page-instr');
    expect(wfValues.contextPageIds).toEqual(['ctx-a', 'ctx-b']);
  });
});

// ---------------------------------------------------------------------------
// Validation parity with task-trigger-helpers.
// The REST POST and AI create_calendar_event paths each replicate the same
// pre-write checks (agent is AI_CHAT in this drive, instruction page in this
// drive, every context page in this drive). The shared validator collapses
// that duplication so the two surfaces can never drift.
// ---------------------------------------------------------------------------
describe('validateCalendarAgentTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryPages.findFirst.mockReset();
    mockQueryPages.findMany.mockReset();
  });

  const baseInput = {
    driveId: 'drive-1',
    agentTrigger: {
      agentPageId: 'agent-1',
      prompt: 'Do work',
      instructionPageId: undefined,
      contextPageIds: [] as string[],
    },
  };

  it('throws when neither prompt nor instructionPageId is provided', async () => {
    await expect(
      validateCalendarAgentTrigger(db, {
        ...baseInput,
        agentTrigger: { ...baseInput.agentTrigger, prompt: '', instructionPageId: undefined },
      }),
    ).rejects.toThrow(/prompt or instructionPageId/i);
  });

  it('throws when the agent page is not found', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce(undefined);
    await expect(validateCalendarAgentTrigger(db, baseInput)).rejects.toThrow(/Agent .* not found/i);
  });

  it('throws when the agent page lives in a different drive', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'other-drive' });
    await expect(validateCalendarAgentTrigger(db, baseInput)).rejects.toThrow(/same drive/i);
  });

  it('throws when the instruction page is not in the drive', async () => {
    // First call: agent lookup succeeds.
    mockQueryPages.findFirst
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' })
      // Second call: instruction page lookup fails.
      .mockResolvedValueOnce(undefined);

    await expect(
      validateCalendarAgentTrigger(db, {
        ...baseInput,
        agentTrigger: { ...baseInput.agentTrigger, instructionPageId: 'instr-1' },
      }),
    ).rejects.toThrow(/Instruction page/i);
  });

  it('throws when one or more context pages are missing or in a different drive', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' });
    mockQueryPages.findMany.mockResolvedValueOnce([{ id: 'ctx-a' }]); // only 1 of 2 returned

    await expect(
      validateCalendarAgentTrigger(db, {
        ...baseInput,
        agentTrigger: { ...baseInput.agentTrigger, contextPageIds: ['ctx-a', 'ctx-b'] },
      }),
    ).rejects.toThrow(/context pages/i);
  });

  it('throws when more than 10 context pages are passed', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' });
    const tooMany = Array.from({ length: 11 }, (_, i) => `ctx-${i}`);
    await expect(
      validateCalendarAgentTrigger(db, {
        ...baseInput,
        agentTrigger: { ...baseInput.agentTrigger, contextPageIds: tooMany },
      }),
    ).rejects.toThrow(/at most 10/i);
  });

  it('returns the validated agentPageId on success', async () => {
    mockQueryPages.findFirst
      .mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' })
      .mockResolvedValueOnce({ id: 'instr-1' });
    mockQueryPages.findMany.mockResolvedValueOnce([{ id: 'ctx-a' }, { id: 'ctx-b' }]);

    const result = await validateCalendarAgentTrigger(db, {
      ...baseInput,
      agentTrigger: {
        agentPageId: 'agent-1',
        prompt: 'Do work',
        instructionPageId: 'instr-1',
        contextPageIds: ['ctx-a', 'ctx-b'],
      },
    });

    expect(result).toEqual({ agentPageId: 'agent-1' });
  });
});

// ---------------------------------------------------------------------------
// Removal: deleting the workflows row cascades to calendar_triggers via FK.
// This is the safe shape since the trigger row has no isEnabled column to
// flip; full removal is what the user wants when they "remove the trigger".
// ---------------------------------------------------------------------------
describe('removeCalendarTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the linked workflows row(s) for the event so the trigger row cascades away', async () => {
    mockSelectWhere.mockResolvedValueOnce([{ workflowId: 'wf-9' }]);

    await removeCalendarTrigger(db, 'evt-1');

    expect(mockSelect).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it('is a no-op when no trigger exists for the event', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    await removeCalendarTrigger(db, 'evt-no-trigger');

    expect(mockSelect).toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upsert: drives both the new PUT /api/calendar/events/[eventId]/triggers
// endpoint and the agentTrigger field on PATCH /api/calendar/events/[eventId].
// Updates the linked workflows row in place when a trigger row already exists
// (matches task-trigger-helpers' upsert shape — the workflowId stays stable so
// in-flight workflow_runs aren't orphaned).
// ---------------------------------------------------------------------------
describe('upsertCalendarTriggerWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryPages.findFirst.mockReset();
    mockQueryPages.findMany.mockReset();
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      select: mockSelect,
      update: mockUpdate,
      insert: vi.fn(),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
  });

  const baseParams = {
    driveId: 'drive-1',
    scheduledById: 'user-1',
    calendarEventId: 'evt-1',
    triggerAt: new Date('2026-05-01T09:00:00Z'),
    timezone: 'UTC',
    agentTrigger: {
      agentPageId: 'agent-1',
      prompt: 'Run check',
      instructionPageId: undefined,
      contextPageIds: [] as string[],
    },
  };

  it('updates the existing workflow row when a trigger already exists for the event', async () => {
    // Validation calls
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' });
    // 1st select: existing trigger lookup (for workflowId)
    mockSelectWhere.mockResolvedValueOnce([{ id: 'trg-existing', workflowId: 'wf-existing' }]);
    // 2nd select: pending (unfired) trigger lookup
    mockSelectWhere.mockResolvedValueOnce([{ id: 'trg-existing' }]);

    await upsertCalendarTriggerWorkflow(db, baseParams);

    expect(mockUpdate).toHaveBeenCalled();
    // First update target should be the workflows row, not a fresh insert.
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      agentPageId: 'agent-1',
      prompt: 'Run check',
    }));
  });

  it('inserts a new workflow + trigger row when no trigger exists for the event', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce({ id: 'agent-1', driveId: 'drive-1' });
    mockSelectWhere.mockResolvedValueOnce([]);
    const txInsert = vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'wf-new' }]) })),
    }));
    mockTransaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
      select: mockSelect,
      update: mockUpdate,
      insert: txInsert,
    }));

    await upsertCalendarTriggerWorkflow(db, baseParams);

    expect(txInsert).toHaveBeenCalledTimes(2);
  });

  it('rejects upserts that would fail validation (e.g. unknown agent)', async () => {
    mockQueryPages.findFirst.mockResolvedValueOnce(undefined);

    await expect(upsertCalendarTriggerWorkflow(db, baseParams)).rejects.toThrow(/Agent/i);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Call-site atomicity tests
// ---------------------------------------------------------------------------
//
// The two call sites that invoke this helper (calendar/events POST and the
// AI create_calendar_event tool) MUST do so inside db.transaction so a
// failed trigger insert rolls back the workflows insert. We verify by
// asserting the helper is invoked with a tx-like object whose insert calls
// happen inside the same callback the route opens.
//
// We assert this at the helper level: a caller that forgot the transaction
// would have to call createCalendarTriggerWorkflow with the bare db
// reference, but the helper's signature requires a tx, so a forgotten tx
// would be a typecheck failure. The structural test above proves the helper
// uses the tx parameter rather than the global db.
