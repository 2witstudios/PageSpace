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

const fileResponse = {
  file: {
    id: 'file-1',
    originalName: 'photo.png',
    size: 1024,
    mimeType: 'image/png',
    contentHash: 'hash-1',
  },
};

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
    vi.clearAllMocks();
  });

  it('uploads a file, stores the attachment, and brackets the upload in startEditing/endEditing', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(fileResponse));
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
    expect(result.current.attachment).toEqual({
      id: 'file-1',
      originalName: 'photo.png',
      size: 1024,
      mimeType: 'image/png',
      contentHash: 'hash-1',
    });
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

  it('clearAttachment resets the stored attachment', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(fileResponse));
    const { result } = renderHook(() =>
      useAttachmentUpload({ uploadUrl: '/api/x/upload' })
    );

    await act(async () => {
      await result.current.uploadFile(makeFile());
    });
    expect(result.current.attachment).not.toBeNull();

    act(() => result.current.clearAttachment());
    expect(result.current.attachment).toBeNull();
  });

  it('drops a second uploadFile call while one is already in flight', async () => {
    let resolveFirst: ((value: Response) => void) | null = null;
    mockFetchWithAuth.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
    );
    mockFetchWithAuth.mockResolvedValueOnce(okResponse(fileResponse));

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
      resolveFirst?.(okResponse(fileResponse));
      await Promise.resolve();
    });
  });
});
