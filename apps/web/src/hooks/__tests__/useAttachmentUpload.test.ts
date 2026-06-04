import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockUploadAttachment, mockToast, startEditing, endEditing } = vi.hoisted(() => ({
  mockUploadAttachment: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  startEditing: vi.fn(),
  endEditing: vi.fn(),
}));

// The hook delegates the per-file presign -> PUT -> complete orchestration to
// uploadAttachment (covered by attachment-client.test.ts). These tests cover the
// hook's own job: state, editing brackets, toasts, and the in-flight guard.
vi.mock('@/lib/upload/attachment-client', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: Object.assign(vi.fn(), {
    getState: () => ({ startEditing, endEditing }),
  }),
}));

import { useAttachmentUpload } from '../useAttachmentUpload';

const attachment = {
  id: 'file-1',
  originalName: 'photo.png',
  size: 1024,
  mimeType: 'image/png',
  contentHash: 'hash-1',
};

// Return a fresh clone each call so tests/uploads never share an attachment reference.
const ok = (a = attachment) => ({ ok: true as const, attachment: { ...a } });
const fail = (errorMessage: string) => ({ ok: false as const, errorMessage });

const makeFile = (name = 'photo.png', type = 'image/png') => new File(['data'], name, { type });

describe('useAttachmentUpload', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uploads a file via uploadAttachment, stores it, and brackets in startEditing/endEditing', async () => {
    mockUploadAttachment.mockResolvedValueOnce(ok());
    const onUploaded = vi.fn();

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload', onUploaded })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockUploadAttachment).toHaveBeenCalledWith('/api/channels/x/upload', expect.any(File));
    expect(result.current.attachment).toMatchObject(attachment);
    expect(typeof result.current.attachment?.instanceId).toBe('string');
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.isUploading).toBe(false);
    expect(onUploaded).toHaveBeenCalledWith(result.current.attachment);
    expect(startEditing).toHaveBeenCalledTimes(1);
    expect(endEditing).toHaveBeenCalledTimes(1);
    expect(startEditing.mock.calls[0][1]).toBe('form');
  });

  it('does nothing when uploadUrl is null', async () => {
    const { result } = renderHook(() => useAttachmentUpload({ uploadUrl: null }));

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockUploadAttachment).not.toHaveBeenCalled();
    expect(startEditing).not.toHaveBeenCalled();
    expect(result.current.attachment).toBeNull();
    expect(result.current.attachments).toHaveLength(0);
  });

  it('shows the failure toast and leaves attachment null when uploadAttachment fails', async () => {
    mockUploadAttachment.mockResolvedValueOnce(fail('File too large'));

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockToast.error).toHaveBeenCalledWith('File too large');
    expect(result.current.attachment).toBeNull();
    expect(endEditing).toHaveBeenCalledTimes(1);
  });

  it('releases the editing session when uploadAttachment throws', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockToast.error).toHaveBeenCalledWith('Failed to upload file. Please try again.');
    await waitFor(() => expect(result.current.isUploading).toBe(false));
    expect(endEditing).toHaveBeenCalledTimes(1);
  });

  it('clearAttachment resets all stored attachments', async () => {
    mockUploadAttachment.mockResolvedValueOnce(ok());
    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });
    expect(result.current.attachment).not.toBeNull();

    act(() => result.current.clearAttachment());
    expect(result.current.attachment).toBeNull();
    expect(result.current.attachments).toHaveLength(0);
  });

  it('removeAttachment removes a single attachment by instanceId', async () => {
    const second = { ...attachment, id: 'file-2', originalName: 'doc.pdf', contentHash: 'hash-2' };
    mockUploadAttachment.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(second));
    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFiles([makeFile(), makeFile('doc.pdf', 'application/pdf')]);
    });
    expect(result.current.attachments).toHaveLength(2);

    const toRemove = result.current.attachments.find(a => a.id === 'file-1')!.instanceId;
    act(() => result.current.removeAttachment(toRemove));
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].id).toBe('file-2');
  });

  it('drops a second uploadFile call while one is already in flight', async () => {
    let resolveFirst: ((v: ReturnType<typeof ok>) => void) | null = null;
    mockUploadAttachment.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      void result.current.uploadFile(makeFile());
      await result.current.uploadFile(makeFile());
    });

    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
    expect(startEditing).toHaveBeenCalledTimes(1);
    expect(endEditing).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirst?.(ok());
      await Promise.resolve();
    });

    expect(endEditing).toHaveBeenCalledTimes(1);
  });

  it('stores successes and toasts per-file failures within one batch', async () => {
    mockUploadAttachment
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('File too large'));

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/channels/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFiles([makeFile(), makeFile('big.mp4', 'video/mp4')]);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].id).toBe('file-1');
    expect(mockToast.error).toHaveBeenCalledWith('File too large');
  });
});
