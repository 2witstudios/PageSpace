import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PageType } from '@pagespace/lib/utils/enums';
import type { FormFieldDef } from '@pagespace/db/schema/form-targets';

const mockFindById = vi.hoisted(() => vi.fn());
const mockApplyPageMutation = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockInsertReturning = vi.hoisted(() => vi.fn());
const mockSelectLimit = vi.hoisted(() => vi.fn());
const mockUpdateReturning = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn());
const mockTxSelectFor = vi.hoisted(() => vi.fn());
const mockTxSelectLimit = vi.hoisted(() => vi.fn());
const mockTxUpdateWhere = vi.hoisted(() => vi.fn());

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
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((...args: unknown[]) => {
        mockInsertValues(...args);
        return { returning: mockInsertReturning };
      }),
    })),
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

import { createFormTarget, lookupActiveFormTarget, updateFormTargetStatus, getFormTargetById, appendFormSubmission } from '../form-target-service';
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
    mockInsertReturning.mockResolvedValue([
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

  it('writes the header row via applyPageMutation before creating the grant', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockApplyPageMutation).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'sheet-1', operation: 'update' })
    );
  });

  it('creates a form_targets row with a hashed token, not the raw token', async () => {
    await createFormTarget({
      sheetPageId: 'sheet-1',
      fields,
      createdBy: 'user-1',
      mutationContext: { userId: 'user-1' },
    });

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.tokenHash).toBeTypeOf('string');
    expect(inserted.tokenHash).toHaveLength(64); // sha3-256 hex
    expect(inserted.createdBy).toBe('user-1');
    expect(inserted.pageId).toBe('sheet-1');
    expect(inserted.driveId).toBe('drive-1');
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

    expect(mockApplyPageMutation.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
