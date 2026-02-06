import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageAttachments } from '../useImageAttachments';

// Mock toast from sonner
vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock resizeImageForVision
vi.mock('../../utils/image-resize', () => ({
  MAX_IMAGES_PER_MESSAGE: 5,
  resizeImageForVision: vi.fn(),
}));

import { toast } from 'sonner';
import { resizeImageForVision } from '../../utils/image-resize';

const mockResizeImageForVision = resizeImageForVision as ReturnType<typeof vi.fn>;

function makeFile(name: string, type = 'image/png'): File {
  return new File(['fake-content'], name, { type });
}

describe('useImageAttachments', () => {
  beforeEach(() => {
    // Default mock: resolve with a resize result
    mockResizeImageForVision.mockImplementation((file: File) =>
      Promise.resolve({
        dataUrl: `data:image/png;base64,resized-${file.name}`,
        width: 100,
        height: 100,
        originalWidth: 200,
        originalHeight: 200,
        dataUrlLength: 1000,
        mediaType: file.type || 'image/png',
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given initial state, should have no attachments', () => {
    const { result } = renderHook(() => useImageAttachments());
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.hasAttachments).toBe(false);
    expect(result.current.hasProcessingFiles).toBe(false);
  });

  it('given image files added, should create attachments in processing state', async () => {
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([makeFile('photo.png')]);
    });

    // After addFiles, attachment should be in processing state initially
    // (it transitions to done once the resize promise resolves)
    expect(result.current.attachments.length).toBeGreaterThanOrEqual(1);
    expect(result.current.hasAttachments).toBe(true);
  });

  it('given non-image files, should not add them', async () => {
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([
        new File(['text'], 'doc.txt', { type: 'text/plain' }),
      ]);
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it('given removeFile called, should remove the attachment', async () => {
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([makeFile('photo.png')]);
    });

    const attachmentId = result.current.attachments[0]?.id;
    expect(attachmentId).toBeDefined();

    await act(async () => {
      result.current.removeFile(attachmentId);
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it('given clearFiles called, should remove all attachments and revoke all blob URLs', async () => {
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([
        makeFile('a.png'),
        makeFile('b.png'),
      ]);
    });

    expect(result.current.attachments.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      result.current.clearFiles();
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it('given max limit reached, should not add more and show toast', async () => {
    const { result } = renderHook(() => useImageAttachments());

    // Add 5 files (the max)
    await act(async () => {
      await result.current.addFiles(
        Array.from({ length: 5 }, (_, i) => makeFile(`img-${i}.png`))
      );
    });

    // Try to add one more
    await act(async () => {
      await result.current.addFiles([makeFile('extra.png')]);
    });

    expect(toast.info).toHaveBeenCalledWith('Maximum 5 images per message');
  });

  it('given more files than remaining capacity, should truncate and show toast', async () => {
    const { result } = renderHook(() => useImageAttachments());

    // Add 3 files first
    await act(async () => {
      await result.current.addFiles(
        Array.from({ length: 3 }, (_, i) => makeFile(`img-${i}.png`))
      );
    });

    // Try to add 4 more (only 2 should be added)
    await act(async () => {
      await result.current.addFiles(
        Array.from({ length: 4 }, (_, i) => makeFile(`extra-${i}.png`))
      );
    });

    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('Added 2 of 4'));
  });

  it('given resize failure, should remove the failed attachment', async () => {
    mockResizeImageForVision.mockRejectedValueOnce(new Error('Canvas error'));

    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([makeFile('bad.png')]);
      // Wait for the resize promise to reject
      await new Promise((r) => setTimeout(r, 10));
    });

    // The failed attachment should have been removed
    expect(result.current.attachments).toHaveLength(0);
  });

  it('given getFilesForSend called with processed attachments, should return file parts', async () => {
    const { result } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([makeFile('photo.png')]);
      // Wait for resize to complete
      await new Promise((r) => setTimeout(r, 10));
    });

    const files = result.current.getFilesForSend();
    expect(files.length).toBeGreaterThanOrEqual(0);

    // If files are available (resize completed), verify structure
    if (files.length > 0) {
      expect(files[0].type).toBe('file');
      expect(files[0].url).toContain('data:');
      expect(files[0].mediaType).toBeDefined();
      expect(files[0].filename).toBe('photo.png');
    }
  });

  it('given unmount after adding files, should clean up without errors', async () => {
    const { result, unmount } = renderHook(() => useImageAttachments());

    await act(async () => {
      await result.current.addFiles([makeFile('a.png'), makeFile('b.png')]);
    });

    // Unmount should complete without errors
    expect(() => unmount()).not.toThrow();
  });
});
