import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PageType } from '@pagespace/lib/utils/enums';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const mockFindById = vi.hoisted(() => vi.fn());
const mockApplyPageMutation = vi.hoisted(() => vi.fn());
const mockSelectLimit = vi.hoisted(() => vi.fn());
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
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
}));

import {
  createFormTarget,
  lookupActiveFormTarget,
  updateFormTargetStatus,
  updateFormTargetFields,
  getFormTargetById,
  getFormTargetByCanvasPageId,
  appendFormSubmission,
  FormTargetAlreadyActiveError,
  FormTargetFieldLimitError,
  FormTargetDuplicateFieldNameError,
  FormTargetFieldIndexError,
} from '../form-target-service';
import { PageRevisionMismatchError } from '../page-mutation-service';

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
      },
    ]);
  });

  it('writes the header row and creates the grant in the same transaction (atomic)', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'sheet-1', operation: 'update', tx: txMock })
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

describe('getFormTargetByCanvasPageId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the row embedded in the given Canvas page regardless of status', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'ft-1', canvasPageId: 'canvas-1', status: 'paused' }]);

    const result = await getFormTargetByCanvasPageId('canvas-1');
    expect(result).toEqual({ id: 'ft-1', canvasPageId: 'canvas-1', status: 'paused' });
  });

  it('returns null when no form target is embedded in the given Canvas page', async () => {
    mockSelectLimit.mockResolvedValue([]);

    const result = await getFormTargetByCanvasPageId('canvas-missing');
    expect(result).toBeNull();
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

    await expect(
      updateFormTargetStatus({ formTargetId: 'missing', status: 'paused' })
    ).rejects.toThrow(/not found/i);
  });
});

describe('updateFormTargetFields', () => {
  const fieldsTarget = {
    id: 'ft-1',
    pageId: 'sheet-1',
    headerRow: 1,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
    ] as FormFieldDef[],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
    mockTxSelectFor.mockResolvedValue([{ ...fieldsTarget, fields: [...fieldsTarget.fields] }]);
    mockTxSelectLimit.mockResolvedValue([{ ...sheetPage, revision: 5 }]);
    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockApplyPageMutation.mockResolvedValue({ nextRevision: 6 });
  });

  it('appends a new field at the next column and writes its header cell', async () => {
    const result = await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'add-field', field: { name: 'phone', label: 'Phone', type: 'text', required: false } },
      mutationContext: { userId: 'user-1' },
    });

    expect(result.fields).toHaveLength(3);
    expect(result.fields[2]).toEqual({ name: 'phone', label: 'Phone', type: 'text', required: false });
    expect(mockApplyPageMutation).toHaveBeenCalledTimes(1);
  });

  it('rejects adding a field once the 20-field cap is reached', async () => {
    const fullFields = Array.from({ length: 20 }, (_, i) => ({
      name: `f${i}`,
      label: `F${i}`,
      type: 'text' as const,
      required: false,
    }));
    mockTxSelectFor.mockResolvedValue([{ ...fieldsTarget, fields: fullFields }]);

    await expect(
      updateFormTargetFields({
        formTargetId: 'ft-1',
        mutation: { op: 'add-field', field: { name: 'one-too-many', label: 'X', type: 'text', required: false } },
        mutationContext: { userId: 'user-1' },
      })
    ).rejects.toThrow(FormTargetFieldLimitError);
  });

  it('rejects reusing an archived field\'s name — two fields must never read the same submitted key', async () => {
    mockTxSelectFor.mockResolvedValue([
      {
        ...fieldsTarget,
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'email', label: 'Email', type: 'email', required: true, archived: true },
        ],
      },
    ]);

    await expect(
      updateFormTargetFields({
        formTargetId: 'ft-1',
        mutation: { op: 'add-field', field: { name: 'email', label: 'Email again', type: 'text', required: false } },
        mutationContext: { userId: 'user-1' },
      })
    ).rejects.toThrow(FormTargetDuplicateFieldNameError);
  });

  it('updates a label and re-syncs the sheet header for that column only', async () => {
    const result = await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'update-field', index: 1, patch: { label: 'Email address' } },
      mutationContext: { userId: 'user-1' },
    });

    expect(result.fields[1].label).toBe('Email address');
    expect(result.fields[0]).toEqual(fieldsTarget.fields[0]); // untouched
    expect(mockApplyPageMutation).toHaveBeenCalledTimes(1);
  });

  it('does not touch the sheet when only required/type change (no label change)', async () => {
    await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'update-field', index: 1, patch: { required: false } },
      mutationContext: { userId: 'user-1' },
    });

    expect(mockApplyPageMutation).not.toHaveBeenCalled();
  });

  it('archives a field without writing to the sheet, preserving its column position', async () => {
    const result = await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'archive-field', index: 0 },
      mutationContext: { userId: 'user-1' },
    });

    expect(result.fields[0]).toMatchObject({ name: 'name', archived: true });
    expect(result.fields[1]).toEqual(fieldsTarget.fields[1]); // untouched, still at column B
    expect(mockApplyPageMutation).not.toHaveBeenCalled();
  });

  it('restores an archived field via unarchive-field', async () => {
    mockTxSelectFor.mockResolvedValue([
      {
        ...fieldsTarget,
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, archived: true },
          { name: 'email', label: 'Email', type: 'email', required: true },
        ],
      },
    ]);

    const result = await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'unarchive-field', index: 0 },
      mutationContext: { userId: 'user-1' },
    });

    expect(result.fields[0]).toMatchObject({ name: 'name', archived: false });
  });

  it('throws for an out-of-range field index', async () => {
    await expect(
      updateFormTargetFields({
        formTargetId: 'ft-1',
        mutation: { op: 'update-field', index: 99, patch: { label: 'X' } },
        mutationContext: { userId: 'user-1' },
      })
    ).rejects.toThrow(FormTargetFieldIndexError);
  });

  it('retries on a page-revision mismatch up to a bounded limit', async () => {
    mockApplyPageMutation
      .mockRejectedValueOnce(new PageRevisionMismatchError('stale', 6, 5))
      .mockResolvedValueOnce({ nextRevision: 7 });

    const result = await updateFormTargetFields({
      formTargetId: 'ft-1',
      mutation: { op: 'add-field', field: { name: 'phone', label: 'Phone', type: 'text', required: false } },
      mutationContext: { userId: 'user-1' },
    });

    expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
    expect(result.fields).toHaveLength(3);
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

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'sheet-1',
        operation: 'update',
        expectedRevision: 5,
        context: expect.objectContaining({
          userId: 'owner-1',
          changeGroupType: 'automation',
          metadata: expect.objectContaining({ source: 'public-form-submission', formTargetId: 'ft-1' }),
        }),
        tx: txMock,
      })
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

  it('retries on a page-revision mismatch up to a bounded limit', async () => {
    mockApplyPageMutation
      .mockRejectedValueOnce(new PageRevisionMismatchError('stale', 6, 5))
      .mockResolvedValueOnce({ nextRevision: 7 });

    await appendFormSubmission({
      formTargetId: 'ft-1',
      values: { name: 'Ada', email: 'ada@example.com' },
      submitterIpHash: 'iphash',
    });

    expect(mockApplyPageMutation).toHaveBeenCalledTimes(2);
  });

  it('gives up after exceeding the bounded retry limit', async () => {
    mockApplyPageMutation.mockRejectedValue(new PageRevisionMismatchError('stale', 6, 5));

    await expect(
      appendFormSubmission({
        formTargetId: 'ft-1',
        values: { name: 'Ada', email: 'ada@example.com' },
        submitterIpHash: 'iphash',
      })
    ).rejects.toThrow(PageRevisionMismatchError);

    expect(mockApplyPageMutation).toHaveBeenCalledTimes(3);
  });
});
