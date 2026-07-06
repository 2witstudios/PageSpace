import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolExecutionContext } from '../../core/types';

const mockCanActorEditPage = vi.hoisted(() => vi.fn());
const mockCreateFormTarget = vi.hoisted(() => vi.fn());
const mockUpdateFormTargetStatus = vi.hoisted(() => vi.fn());
const mockGetFormTargetById = vi.hoisted(() => vi.fn());
const mockBuildFormHtml = vi.hoisted(() => vi.fn());

vi.mock('../actor-permissions', () => ({
  canActorEditPage: mockCanActorEditPage,
}));

vi.mock('@/services/api/form-target-service', () => ({
  createFormTarget: mockCreateFormTarget,
  updateFormTargetStatus: mockUpdateFormTargetStatus,
  getFormTargetById: mockGetFormTargetById,
  FormTargetPageNotSheetError: class FormTargetPageNotSheetError extends Error {},
  FormTargetAlreadyActiveError: class FormTargetAlreadyActiveError extends Error {},
  FormTargetArchivedError: class FormTargetArchivedError extends Error {},
}));

vi.mock('@pagespace/lib/forms/form-html', () => ({
  buildFormHtml: mockBuildFormHtml,
}));

import { formTools, formFieldsSchema } from '../form-tools';

const context = (userId?: string) => ({
  toolCallId: '1',
  messages: [],
  experimental_context: (userId ? { userId } : {}) as ToolExecutionContext,
});

const fields = [
  { name: 'name', label: 'Name', type: 'text' as const, required: true },
  { name: 'email', label: 'Email', type: 'email' as const, required: true },
];

describe('provision_form_target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
  });

  it('requires user authentication', async () => {
    await expect(
      formTools.provision_form_target.execute!({ sheetPageId: 'sheet-1', fields }, context())
    ).rejects.toThrow('User authentication required');
  });

  it('rejects an actor without edit permission on the target page', async () => {
    mockCanActorEditPage.mockResolvedValue(false);

    await expect(
      formTools.provision_form_target.execute!({ sheetPageId: 'sheet-1', fields }, context('user-1'))
    ).rejects.toThrow(/permission/i);

    expect(mockCreateFormTarget).not.toHaveBeenCalled();
  });

  it('provisions a form and returns the embeddable HTML for an actor with edit permission', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    mockCreateFormTarget.mockResolvedValue({
      token: 'pft_rawtoken',
      formTarget: { id: 'ft-1', pageId: 'sheet-1' },
    });
    mockBuildFormHtml.mockReturnValue('<form>...</form>');

    const result = await formTools.provision_form_target.execute!(
      { sheetPageId: 'sheet-1', fields },
      context('user-1')
    );

    expect(result).toMatchObject({
      success: true,
      formTargetId: 'ft-1',
      pageId: 'sheet-1',
      formHtml: '<form>...</form>',
    });
    if (!('submitUrl' in result)) throw new Error('Expected a submitUrl in the result');
    expect(result.submitUrl).toContain('pft_rawtoken');
    expect(mockCreateFormTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sheetPageId: 'sheet-1', fields, createdBy: 'user-1' })
    );
  });

  it('rejects duplicate field names at the schema gate (FormData would silently drop one)', () => {
    const duplicateFields = [
      { name: 'name', label: 'Name', type: 'text' as const, required: true },
      { name: 'name', label: 'Full Name', type: 'text' as const, required: true },
    ];
    const result = formFieldsSchema.safeParse(duplicateFields);

    expect(result.success).toBe(false);
  });

  it('returns a structured error when the target page is not a SHEET', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    const { FormTargetPageNotSheetError } = await import('@/services/api/form-target-service');
    mockCreateFormTarget.mockRejectedValue(new FormTargetPageNotSheetError('Page "sheet-1" is not a SHEET page'));

    const result = await formTools.provision_form_target.execute!(
      { sheetPageId: 'sheet-1', fields },
      context('user-1')
    );

    expect(result).toMatchObject({ success: false });
    if (!('error' in result)) throw new Error('Expected an error in the result');
    expect(result.error).toMatch(/not a SHEET/i);
  });

  it('returns a structured error when the sheet already has an active form target', async () => {
    mockCanActorEditPage.mockResolvedValue(true);
    const { FormTargetAlreadyActiveError } = await import('@/services/api/form-target-service');
    mockCreateFormTarget.mockRejectedValue(new FormTargetAlreadyActiveError('Sheet "sheet-1" already has an active form target'));

    const result = await formTools.provision_form_target.execute!(
      { sheetPageId: 'sheet-1', fields },
      context('user-1')
    );

    expect(result).toMatchObject({ success: false });
    if (!('error' in result)) throw new Error('Expected an error in the result');
    expect(result.error).toMatch(/already has an active form target/i);
  });
});

describe('update_form_target_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires user authentication', async () => {
    await expect(
      formTools.update_form_target_status.execute!(
        { formTargetId: 'ft-1', status: 'paused' },
        context()
      )
    ).rejects.toThrow('User authentication required');
  });

  it('rejects when the form target does not exist', async () => {
    mockGetFormTargetById.mockResolvedValue(null);

    await expect(
      formTools.update_form_target_status.execute!(
        { formTargetId: 'missing', status: 'paused' },
        context('user-1')
      )
    ).rejects.toThrow(/not found/i);

    expect(mockCanActorEditPage).not.toHaveBeenCalled();
  });

  it('rejects an actor without edit permission on the form target\'s own page', async () => {
    mockGetFormTargetById.mockResolvedValue({ id: 'ft-1', pageId: 'sheet-1' });
    mockCanActorEditPage.mockResolvedValue(false);

    await expect(
      formTools.update_form_target_status.execute!(
        { formTargetId: 'ft-1', status: 'paused' },
        context('user-1')
      )
    ).rejects.toThrow(/permission/i);

    expect(mockUpdateFormTargetStatus).not.toHaveBeenCalled();
  });

  it('pauses the form target for an actor with edit permission, taking effect immediately', async () => {
    mockGetFormTargetById.mockResolvedValue({ id: 'ft-1', pageId: 'sheet-1' });
    mockCanActorEditPage.mockResolvedValue(true);
    mockUpdateFormTargetStatus.mockResolvedValue({ id: 'ft-1', status: 'paused' });

    const result = await formTools.update_form_target_status.execute!(
      { formTargetId: 'ft-1', status: 'paused', reason: 'spam spike' },
      context('user-1')
    );

    expect(mockUpdateFormTargetStatus).toHaveBeenCalledWith({
      formTargetId: 'ft-1',
      status: 'paused',
      statusReason: 'spam spike',
    });
    expect(result).toMatchObject({ success: true, status: 'paused', pageId: 'sheet-1' });
  });

  it('returns a structured error instead of reviving an archived target', async () => {
    mockGetFormTargetById.mockResolvedValue({ id: 'ft-1', pageId: 'sheet-1', status: 'archived' });
    mockCanActorEditPage.mockResolvedValue(true);
    const { FormTargetArchivedError } = await import('@/services/api/form-target-service');
    mockUpdateFormTargetStatus.mockRejectedValue(
      new FormTargetArchivedError('Form target "ft-1" is archived — archiving is permanent and cannot be reversed')
    );

    const result = await formTools.update_form_target_status.execute!(
      { formTargetId: 'ft-1', status: 'active' },
      context('user-1')
    );

    expect(result).toMatchObject({ success: false });
    if (!('error' in result)) throw new Error('Expected an error in the result');
    expect(result.error).toMatch(/archived/i);
  });
});
