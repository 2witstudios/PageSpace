import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockFetchWithAuth, mockToast, startEditing, endEditing } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  startEditing: vi.fn(),
  endEditing: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: Object.assign(vi.fn(), {
    getState: () => ({ startEditing, endEditing }),
  }),
}));

import { useAttachmentUpload } from '../useAttachmentUpload';

const fileData = {
  id: 'file-1',
  originalName: 'photo.png',
  size: 1024,
  mimeType: 'image/png',
  contentHash: 'hash-1',
};

// Batch response shape used by processAttachmentUploads
const batchResponse = (files: { success: boolean; file?: typeof fileData; error?: string; fileName?: string }[]) => ({
  files,
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
}) as unknown as Response;

const errorResponse = (status: number, body: unknown = {}) => ({
  ok: false,
  status,
  json: async () => body,
}) as unknown as Response;

const makeFile = () => new File(['data'], 'photo.png', { type: 'image/png' });

describe('useAttachmentUpload', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uploads a file, stores the attachment, and brackets the upload in startEditing/endEditing', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(batchResponse([{ success: true, file: fileData }])));
    const onUploaded = vi.fn();

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload', onUploaded })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/x/upload',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.current.attachment).toEqual(fileData);
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

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(startEditing).not.toHaveBeenCalled();
    expect(result.current.attachment).toBeNull();
    expect(result.current.attachments).toHaveLength(0);
  });

  it('shows the file-too-large toast on 413 and leaves attachment null', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      errorResponse(413, { error: 'File too large' })
    );

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockToast.error).toHaveBeenCalledWith('File too large');
    expect(result.current.attachment).toBeNull();
    expect(endEditing).toHaveBeenCalledTimes(1);
  });

  it('releases the editing session when the request throws', async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });

    expect(mockToast.error).toHaveBeenCalledWith(
      'Failed to upload file. Please try again.'
    );
    await waitFor(() => expect(result.current.isUploading).toBe(false));
    expect(endEditing).toHaveBeenCalledTimes(1);
  });

  it('clearAttachment resets all stored attachments', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(batchResponse([{ success: true, file: fileData }])));
    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });
    expect(result.current.attachment).not.toBeNull();

    act(() => result.current.clearAttachment());
    expect(result.current.attachment).toBeNull();
    expect(result.current.attachments).toHaveLength(0);
  });

  it('removeAttachment removes a single attachment by id', async () => {
    const file2 = { ...fileData, id: 'file-2', originalName: 'doc.pdf', contentHash: 'hash-2' };
    mockFetchWithAuth.mockResolvedValueOnce(
      okResponse(batchResponse([{ success: true, file: fileData }, { success: true, file: file2 }]))
    );
    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFiles([makeFile(), new File(['data'], 'doc.pdf', { type: 'application/pdf' })]);
    });
    expect(result.current.attachments).toHaveLength(2);

    act(() => result.current.removeAttachment('file-1'));
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].id).toBe('file-2');
  });

  it('drops a second uploadFile call while one is already in flight', async () => {
    let resolveFirst: ((value: Response) => void) | null = null;
    mockFetchWithAuth.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
    );
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(batchResponse([{ success: true, file: fileData }])));

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    let secondCall: Promise<void> | undefined;
    await act(async () => {
      void result.current.uploadFile(makeFile());
      secondCall = result.current.uploadFile(makeFile());
      await secondCall;
    });

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(startEditing).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.(okResponse(batchResponse([{ success: true, file: fileData }])));
      await Promise.resolve();
    });
  });

  it('shows per-file error toast when a file in the batch fails', async () => {
    const files = [
      { success: true as const, file: fileData },
      { success: false as const, error: 'File too large', fileName: 'big.mp4' },
    ];
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ files }),
    } as unknown as Response);

    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFiles([makeFile(), new File(['data'], 'big.mp4', { type: 'video/mp4' })]);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].id).toBe('file-1');
    expect(mockToast.error).toHaveBeenCalledWith('File too large');
  });
});
