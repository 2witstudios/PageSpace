/**
 * useFileDrop Hook Tests
 * Tests for file drag and drop with direct-to-S3 upload functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DragEvent } from 'react';

// Hoisted mocks for the storage pre-check and the direct-to-S3 orchestrator
const { mockPost, mockUpload } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockUpload: vi.fn(),
}));

const { mockToast } = vi.hoisted(() => ({
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// Mock @pagespace/lib - must be mocked to avoid resolution issues in test environment
vi.mock('@pagespace/lib/services/storage-limits', () => ({
  formatBytes: (bytes: number) => `${bytes} bytes`,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

vi.mock('@/lib/upload/orchestrator', () => ({
  uploadFileToS3: (...args: unknown[]) => mockUpload(...args),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

import { useFileDrop } from '../useFileDrop';

// Use the hoisted mock directly
const toast = mockToast;

// Helper to create mock DragEvent
const createMockDragEvent = (files: File[] = [], options: Partial<DragEvent> = {}): DragEvent => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: {
    types: files.length > 0 ? ['Files'] : [],
    files: files as unknown as FileList,
    dropEffect: 'none',
  },
  currentTarget: {
    getBoundingClientRect: () => ({
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
    }),
  },
  clientX: 50,
  clientY: 50,
  ...options,
} as unknown as DragEvent);

// Helper to create mock File with optional mocked size (avoids large memory allocation)
const createMockFile = (name: string, size: number, type = 'text/plain'): File => {
  const file = new File(['x'], name, { type });
  // Override size property to avoid allocating large buffers for boundary tests
  Object.defineProperty(file, 'size', { value: size, writable: false });
  return file;
};

describe('useFileDrop', () => {
  const defaultOptions = {
    driveId: 'drive-123',
    parentId: null,
    onUploadComplete: vi.fn(),
    onUploadError: vi.fn(),
  };

  const originalMaxFileSize = process.env.NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment variable
    process.env.NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB = '20';
    mockPost.mockResolvedValue({ ok: true });
    mockUpload.mockResolvedValue({ id: 'page-1' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Restore original environment variable to avoid cross-test leakage
    process.env.NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB = originalMaxFileSize;
  });

  describe('initial state', () => {
    it('given hook is initialized, should have correct initial state', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      expect(result.current.isDraggingFiles).toBe(false);
      expect(result.current.isUploading).toBe(false);
      expect(result.current.uploadProgress).toBe(0);
    });
  });

  describe('isFileDrag', () => {
    it('given drag event with Files type, should return true', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      expect(result.current.isFileDrag(event)).toBe(true);
    });

    it('given drag event without Files type, should return false', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([]);

      expect(result.current.isFileDrag(event)).toBe(false);
    });

    it('given null dataTransfer types, should return false', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = {
        dataTransfer: { types: null },
      } as unknown as DragEvent;

      expect(result.current.isFileDrag(event)).toBe(false);
    });
  });

  describe('handleDragEnter', () => {
    it('given file drag event, should set isDraggingFiles to true', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingFiles).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('given non-file drag event, should not change state', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([]);

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingFiles).toBe(false);
    });
  });

  describe('handleDragLeave', () => {
    it('given cursor leaves drop zone, should set isDraggingFiles to false', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      // First set dragging to true
      act(() => {
        result.current.handleDragEnter(createMockDragEvent([createMockFile('test.txt', 100)]));
      });

      // Then leave (cursor outside bounds)
      const leaveEvent = createMockDragEvent([createMockFile('test.txt', 100)], {
        clientX: -10, // Outside left boundary
        clientY: 50,
      });

      act(() => {
        result.current.handleDragLeave(leaveEvent);
      });

      expect(result.current.isDraggingFiles).toBe(false);
    });
  });

  describe('handleDragOver', () => {
    it('given file drag event, should prevent default and set dropEffect', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      act(() => {
        result.current.handleDragOver(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(event.dataTransfer?.dropEffect).toBe('copy');
    });
  });

  describe('handleFileDrop', () => {
    it('given valid file drop, should upload files and call onUploadComplete', async () => {
      const onUploadComplete = vi.fn();
      const { result } = renderHook(() =>
        useFileDrop({ ...defaultOptions, onUploadComplete })
      );

      const file = createMockFile('test.txt', 100);
      const event = createMockDragEvent([file]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(mockPost).toHaveBeenCalledWith('/api/storage/check', { fileSize: 100 });
      expect(mockUpload).toHaveBeenCalledTimes(1);
      expect(onUploadComplete).toHaveBeenCalled();
    });

    it('given valid file drop, should pass driveId and parentId target', async () => {
      const { result } = renderHook(() =>
        useFileDrop({ ...defaultOptions, parentId: 'drive-root' })
      );

      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      const [fileArg, target] = mockUpload.mock.calls[0];
      expect((fileArg as File).name).toBe('test.txt');
      expect(target).toMatchObject({ driveId: 'drive-123', parentId: 'drive-root' });
    });

    it('given oversized file, should show error toast and not upload', async () => {
      const maxSize = 20 * 1024 * 1024; // 20MB
      const oversizedFile = createMockFile('large.txt', maxSize + 1);
      const event = createMockDragEvent([oversizedFile]);

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(toast.error).toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('given storage quota exceeded, should show error and not upload', async () => {
      mockPost.mockRejectedValue(new Error('Quota exceeded'));

      const file = createMockFile('test.txt', 100);
      const event = createMockDragEvent([file]);

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(toast.error).toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('given multiple files, should upload all and track progress', async () => {
      const files = [
        createMockFile('file1.txt', 100),
        createMockFile('file2.txt', 200),
        createMockFile('file3.txt', 300),
      ];
      const event = createMockDragEvent(files);

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(mockUpload).toHaveBeenCalledTimes(3);
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('3')
      );
    });

    it('given a per-file upload failure, should toast and continue the batch', async () => {
      mockUpload
        .mockRejectedValueOnce(new Error('Upload failed'))
        .mockResolvedValueOnce({ id: 'page-2' });

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      const event = createMockDragEvent([
        createMockFile('bad.txt', 100),
        createMockFile('good.txt', 100),
      ]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(mockUpload).toHaveBeenCalledTimes(2);
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Upload failed'));
    });

    it('given custom parentId in drop, should use it instead of default', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event, 'custom-parent-123');
      });

      const [, target] = mockUpload.mock.calls[0];
      expect(target.parentId).toBe('custom-parent-123');
    });

    it('given non-file drag event, should not process', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('given empty files array, should not process', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      // Event with Files type but empty files
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['Files'],
          files: [] as unknown as FileList,
        },
      } as unknown as DragEvent;

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('resetDragState', () => {
    it('given dragging state is true, should reset to false', () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      // Set dragging to true
      act(() => {
        result.current.handleDragEnter(createMockDragEvent([createMockFile('test.txt', 100)]));
      });

      expect(result.current.isDraggingFiles).toBe(true);

      // Reset
      act(() => {
        result.current.resetDragState();
      });

      expect(result.current.isDraggingFiles).toBe(false);
    });
  });

  describe('upload progress tracking', () => {
    it('given multiple file upload, should reset progress when finished', async () => {
      const files = [
        createMockFile('file1.txt', 100),
        createMockFile('file2.txt', 100),
      ];
      const event = createMockDragEvent(files);

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      // After upload completes, progress should reset to 0
      expect(result.current.uploadProgress).toBe(0);
      expect(result.current.isUploading).toBe(false);
    });
  });

  describe('position data handling', () => {
    it('given position and afterNodeId, should include them in the upload target', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event, 'parent-123', 'after', 'sibling-456');
      });

      const [, target] = mockUpload.mock.calls[0];
      expect(target).toMatchObject({
        parentId: 'parent-123',
        position: 'after',
        afterNodeId: 'sibling-456',
      });
    });
  });
});
