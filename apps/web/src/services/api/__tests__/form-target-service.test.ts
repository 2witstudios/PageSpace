import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PageType } from '@pagespace/lib/utils/enums';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const mockFindById = vi.hoisted(() => vi.fn());
const mockApplyPageMutation = vi.hoisted(() => vi.fn());
const mockSetCells = vi.hoisted(() => vi.fn());
const mockLogActivityWithTx = vi.hoisted(() => vi.fn());
const mockSelectLimit = vi.hoisted(() => vi.fn());
const mockOrderBy = vi.hoisted(() => vi.fn());
const mockUpdateReturning = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const mockTxSelectFor = vi.hoisted(() => vi.fn());
const mockTxSelectLimit = vi.hoisted(() => vi.fn());
const mockTxUpdateWhere = vi.hoisted(() => vi.fn());
const mockTxInsertValues = vi.hoisted(() => vi.fn());
const mockTxInsertReturning = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: { findById: mockFindById },
}));

vi.mock('../page-mutation-service', () => ({
  applyPageMutation: mockApplyPageMutation,
  PageRevisionMismatchError: class PageRevisionMismatchError extends Error {},
}));

vi.mock('@pagespace/lib/sheets/store', () => ({
  setCells: mockSetCells,
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logActivityWithTx: mockLogActivityWithTx,
}));

const txMock = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: mockTxSelectFor,
        limit: mockTxSelectLimit,
      })),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: mockTxUpdateWhere,
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn((...args: unknown[]) => {
      mockTxInsertValues(...args);
      return { returning: mockTxInsertReturning };
    }),
  })),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockSelectLimit,
          orderBy: mockOrderBy,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
    transaction: mockTransaction,
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  ne: vi.fn((field: unknown, value: unknown) => ({ field, value, ne: true })),
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  desc: vi.fn((field: unknown) => ({ field, desc: true })),
}));

import {
  createFormTarget,
  lookupActiveFormTarget,
  updateFormTargetStatus,
  updateFormTargetNotification,
  getFormTargetById,
  getFormTargetsByCanvasPageId,
  appendFormSubmission,
  FormTargetAlreadyActiveError,
  FormTargetArchivedError,
} from '../form-target-service';

const fields: FormFieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
];

const sheetPage = {
  id: 'sheet-1',
  driveId: 'drive-1',
  type: PageType.SHEET,
  content: '',
  revision: 1,
};

/**
 * Carries the SheetDoc magic but a malformed body. The lossy parse turns this
 * into an EMPTY sheet, so appending to it would store a document containing
 * only the appended cells — replacing the user's entire spreadsheet.
 */
const UNREADABLE_SHEET = '#%PAGESPACE_SHEETDOC v1\nthis is [not toml';

describe('createFormTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(sheetPage);
    mockApplyPageMutation.mockResolvedValue({ nextRevision: 2 });
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
    mockTxInsertReturning.mockResolvedValue([
      {
        id: 'ft-1',
        tokenHash: 'hash',
        tokenPrefix: 'pft_abc',
        driveId: 'drive-1',
        pageId: 'sheet-1',
        action: 'sheet:append',
        fields,
        headerRow: 1,
        nextRow: 2,
        status: 'active',
        createdBy: 'user-1',
        notificationEmail: null,
      },
    ]);
  });

  it('writes headers as addressed cells, without reading the sheet body', async () => {
    // Replaces "refuses to write headers when the sheet could not be read".
    // That guard existed because creating a form re-serialised the WHOLE
    // document, so an unparseable read would have replaced the spreadsheet
    // with just these header cells. Header writes are addressed cell writes
    // now, so there is no document to misparse and nothing to overwrite —
    // an unreadable body is no longer reachable, rather than handled.
    mockFindById.mockResolvedValue({ ...sheetPage, content: UNREADABLE_SHEET });

    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockSetCells).toHaveBeenCalledTimes(1);
    const [ref, updates] = mockSetCells.mock.calls[0];
    expect(ref).toEqual({ pageId: 'sheet-1' });
    // Header cells only — never the rest of the grid.
    expect(updates.every((u: { address: string }) => /1$/.test(u.address))).toBe(true);
  });

  it('writes the header row and creates the grant in the same transaction (atomic)', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // Same transaction as the grant insert, so a form cannot exist without its
    // headers or vice versa.
    expect(mockSetCells).toHaveBeenCalledWith(
      { pageId: 'sheet-1' },
      expect.any(Array),
      expect.any(Object),
      txMock
    );
  });

  it('creates a form_targets row with a hashed token, not the raw token', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockTxInsertValues).toHaveBeenCalledTimes(1);
    const inserted = mockTxInsertValues.mock.calls[0][0];
    expect(inserted.tokenHash).toBeTypeOf('string');
    expect(inserted.tokenHash).toHaveLength(64); // sha3-256 hex
    expect(inserted.createdBy).toBe('user-1');
    expect(inserted.pageId).toBe('sheet-1');
    expect(inserted.driveId).toBe('drive-1');
  });

  it('throws FormTargetAlreadyActiveError when the sheet already has an active form target', async () => {
    const conflictError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockTxInsertReturning.mockRejectedValue(conflictError);

    await expect(
      createFormTarget({
        sheetPageId: 'sheet-1',
        fields,
        createdBy: 'user-1',
        mutationContext: { userId: 'user-1' },
      })
    ).rejects.toThrow(FormTargetAlreadyActiveError);
  });

  it('returns a raw token distinct from the stored hash', async () => {
    const result = await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(result.token).toBeTypeOf('string');
    expect(result.token).not.toBe(result.formTarget.tokenHash);
  });

  it('rejects a target page that is not a SHEET', async () => {
    mockFindById.mockResolvedValue({ ...sheetPage, type: PageType.DOCUMENT });

    await expect(
      createFormTarget({
        sheetPageId: 'sheet-1',
        fields,
        createdBy: 'user-1',
        mutationContext: { userId: 'user-1' },
      })
    ).rejects.toThrow(/not a SHEET/i);
  });

  it('creates the row scoped to the given canvasPageId without touching any other row', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
      canvasPageId: 'canvas-1',
    });

    expect(mockTxInsertValues.mock.calls[0][0].canvasPageId).toBe('canvas-1');
    expect(txMock.update).not.toHaveBeenCalled();
  });

  it('stores notificationEmail when provided', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
      notificationEmail: 'owner@example.com',
    });

    expect(mockTxInsertValues.mock.calls[0][0].notificationEmail).toBe('owner@example.com');
  });

  it('defaults notificationEmail to null when omitted', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockTxInsertValues.mock.calls[0][0].notificationEmail).toBeNull();
  });
});

describe('lookupActiveFormTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the matching row when an active token hash is found', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'ft-1', status: 'active' }]);

    const result = await lookupActiveFormTarget('pft_realtoken');
    expect(result).toEqual({ id: 'ft-1', status: 'active' });
  });

  it('returns null for a non-existent or non-active token (no distinguishable signal)', async () => {
    mockSelectLimit.mockResolvedValue([]);

    const result = await lookupActiveFormTarget('pft_unknown');
    expect(result).toBeNull();
  });
});

describe('getFormTargetById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the row for a known id regardless of status', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'ft-1', pageId: 'sheet-1', status: 'paused' }]);

    const result = await getFormTargetById('ft-1');
    expect(result).toEqual({ id: 'ft-1', pageId: 'sheet-1', status: 'paused' });
  });

  it('returns null for an unknown id', async () => {
    mockSelectLimit.mockResolvedValue([]);

    const result = await getFormTargetById('missing');
    expect(result).toBeNull();
  });
});

describe('getFormTargetsByCanvasPageId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns every row wired to the given Canvas page regardless of status', async () => {
    mockOrderBy.mockResolvedValue([
      { id: 'ft-1', canvasPageId: 'canvas-1', status: 'active' },
      { id: 'ft-2', canvasPageId: 'canvas-1', status: 'paused' },
    ]);

    const result = await getFormTargetsByCanvasPageId('canvas-1');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(['ft-1', 'ft-2']);
  });

  it('returns an empty array when no form target is wired to the given Canvas page', async () => {
    mockOrderBy.mockResolvedValue([]);

    const result = await getFormTargetsByCanvasPageId('canvas-missing');
    expect(result).toEqual([]);
  });
});

describe('updateFormTargetStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the status column and returns the updated row', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: 'ft-1', status: 'paused' }]);

    const result = await updateFormTargetStatus({ formTargetId: 'ft-1', status: 'paused' });
    expect(result.status).toBe('paused');
  });

  it('throws when the form target does not exist', async () => {
    mockUpdateReturning.mockResolvedValue([]);
    mockSelectLimit.mockResolvedValue([]);

    await expect(
      updateFormTargetStatus({ formTargetId: 'missing', status: 'paused' })
    ).rejects.toThrow(/not found/i);
  });

  it('throws FormTargetArchivedError instead of reviving an archived target', async () => {
    // The conditional WHERE excludes archived rows from a non-archived status,
    // so the UPDATE affects zero rows — same as if the row didn't exist.
    mockUpdateReturning.mockResolvedValue([]);
    mockSelectLimit.mockResolvedValue([{ id: 'ft-1', status: 'archived' }]);

    await expect(
      updateFormTargetStatus({ formTargetId: 'ft-1', status: 'active' })
    ).rejects.toThrow(FormTargetArchivedError);
  });

  it('allows archiving an already-archived target (idempotent)', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: 'ft-1', status: 'archived' }]);

    const result = await updateFormTargetStatus({ formTargetId: 'ft-1', status: 'archived' });
    expect(result.status).toBe('archived');
  });
});

describe('updateFormTargetNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the notificationEmail column and returns the updated row', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: 'ft-1', notificationEmail: 'new@example.com' }]);

    const result = await updateFormTargetNotification({
      formTargetId: 'ft-1',
      notificationEmail: 'new@example.com',
    });
    expect(result.notificationEmail).toBe('new@example.com');
  });

  it('sets notificationEmail to null when clearing', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: 'ft-1', notificationEmail: null }]);

    const result = await updateFormTargetNotification({
      formTargetId: 'ft-1',
      notificationEmail: null,
    });
    expect(result.notificationEmail).toBeNull();
  });

  it('throws when the form target does not exist', async () => {
    mockUpdateReturning.mockResolvedValue([]);

    await expect(
      updateFormTargetNotification({ formTargetId: 'missing', notificationEmail: null })
    ).rejects.toThrow(/not found/i);
  });
});

const lockedFormTarget = {
  id: 'ft-1',
  pageId: 'sheet-1',
  createdBy: 'owner-1',
  fields,
  nextRow: 2,
  submissionCount: 0,
};

describe('appendFormSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock));
    mockTxSelectFor.mockResolvedValue([lockedFormTarget]);
    mockTxSelectLimit.mockResolvedValue([{ ...sheetPage, revision: 5 }]);
    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockApplyPageMutation.mockResolvedValue({ nextRevision: 6 });
  });

  it('writes only the submitted row, never the rest of the sheet', async () => {
    // Replaces "refuses to append when the sheet could not be read". That
    // guard protected against an anonymous form POST re-serialising a
    // spreadsheet it had failed to parse, replacing it with just the submitted
    // row. A submission is an addressed cell write now: there is no read of
    // the document body to fail, and no path by which one submission can touch
    // another row. The stronger property is asserted directly.
    mockTxSelectLimit.mockResolvedValue([
      { ...sheetPage, content: UNREADABLE_SHEET, revision: 5 },
    ]);

    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockSetCells).toHaveBeenCalledTimes(1);
    const [, updates] = mockSetCells.mock.calls[0];
    // `nextRow` is 2, so every address must be on row 2 and nowhere else.
    expect(updates.every((u: { address: string }) => u.address.endsWith('2'))).toBe(true);
  });

  it('appends to a sheet that reads fine', async () => {
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockSetCells).toHaveBeenCalledTimes(1);
  });

  it('locks the form_targets row before appending (FOR UPDATE)', async () => {
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockTxSelectFor).toHaveBeenCalledTimes(1);
  });

  it('appends the row attributed to the token owner with automation changeGroupType', async () => {
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    // Attribution rides on the cell write itself: the token owner is the
    // actor, and the form target groups the change so a submission is
    // identifiable in the sheet's change log.
    expect(mockSetCells).toHaveBeenCalledWith(
      { pageId: 'sheet-1' },
      expect.any(Array),
      expect.objectContaining({ userId: 'owner-1' }),
      txMock
    );

    // A change group PER SUBMISSION, not the form target's id. Page history
    // groups activities by (pageId, changeGroupId), so pinning it to the form
    // would render five thousand submissions as a single history entry.
    const [, , actor] = mockSetCells.mock.calls[0];
    expect(actor.changeGroupId).toBeTruthy();
    expect(actor.changeGroupId).not.toBe('ft-1');
    expect(mockLogActivityWithTx).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1', changeGroupType: 'automation' }),
      txMock
    );
  });

  it('advances nextRow and submissionCount after a successful append', async () => {
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(txMock.update).toHaveBeenCalled();
  });

  it('appends exactly once — there is no revision race left to retry', async () => {
    // Replaces two tests that asserted a bounded retry on
    // `PageRevisionMismatchError`. That loop existed because the append
    // re-serialised the whole document under an `expectedRevision` check, so
    // a second form targeting the same sheet could lose the race. Addressed
    // cell writes do not contend — two forms writing different rows of one
    // sheet no longer conflict — and the `FOR UPDATE` lock below already
    // serialises submissions to the SAME form. The loop became unreachable, so
    // it was removed rather than left as decoration; this pins the single-shot
    // behaviour that replaced it.
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockSetCells).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('records the submission provenance without the document', async () => {
    // The hashed submitter IP is the audit trail for an anonymous, publicly
    // reachable write. It used to ride in the page mutation's activity log
    // alongside the whole sheet; the log entry stays, the payload does not.
    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockLogActivityWithTx).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: 'public-form-submission',
          formTargetId: 'ft-1',
          submitterIpHash: 'iphash',
        }),
      }),
      txMock
    );
    const [entry] = mockLogActivityWithTx.mock.calls[0];
    expect(entry.contentSnapshot).toBeUndefined();
  });
});
