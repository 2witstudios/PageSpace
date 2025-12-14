/**
 * useFileDrop Hook Tests
 * Tests for file drag and drop with upload functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DragEvent } from 'react';

// Create hoisted mocks for auth-fetch
const { mockPost, mockFetchWithAuth } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockFetchWithAuth: vi.fn(),
}));

// Create hoisted mock for toast
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

// Mock dependencies with hoisted mocks
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
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

// Helper to create mock File
const createMockFile = (name: string, size: number, type = 'text/plain'): File => {
  return new File(['x'.repeat(size)], name, { type });
};

describe('useFileDrop', () => {
  const defaultOptions = {
    driveId: 'drive-123',
    parentId: null,
    onUploadComplete: vi.fn(),
    onUploadError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment variable
    process.env.NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB = '20';
    mockPost.mockResolvedValue({ ok: true });
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ page: { id: 'page-1' } }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      expect(mockFetchWithAuth).toHaveBeenCalled();
      expect(onUploadComplete).toHaveBeenCalled();
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
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
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
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
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

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('3')
      );
    });

    it('given upload failure, should call onUploadError', async () => {
      const onUploadError = vi.fn();
      mockFetchWithAuth.mockRejectedValue(new Error('Upload failed'));

      const { result } = renderHook(() =>
        useFileDrop({ ...defaultOptions, onUploadError })
      );

      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(onUploadError).toHaveBeenCalled();
    });

    it('given custom parentId in drop, should use it instead of default', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));

      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event, 'custom-parent-123');
      });

      const formData = mockFetchWithAuth.mock.calls[0][1].body as FormData;
      expect(formData.get('parentId')).toBe('custom-parent-123');
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
    it('given multiple file upload, should track upload progress', async () => {
      const files = [
        createMockFile('file1.txt', 100),
        createMockFile('file2.txt', 100),
      ];
      const event = createMockDragEvent(files);

      const { result } = renderHook(() => useFileDrop(defaultOptions));

      mockFetchWithAuth.mockImplementation(async () => {
        return {
          ok: true,
          json: () => Promise.resolve({ page: { id: 'page-1' } }),
        };
      });

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      // After upload completes, progress should reset to 0
      expect(result.current.uploadProgress).toBe(0);
      expect(result.current.isUploading).toBe(false);
    });
  });

  describe('position data handling', () => {
    it('given position and afterNodeId, should include in upload', async () => {
      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event, 'parent-123', 'after', 'sibling-456');
      });

      const formData = mockFetchWithAuth.mock.calls[0][1].body as FormData;
      expect(formData.get('position')).toBe('after');
      expect(formData.get('afterNodeId')).toBe('sibling-456');
    });
  });

  describe('storage warnings', () => {
    it('given storage over 80%, should show warning toast', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          page: { id: 'page-1' },
          storageInfo: { used: 85, quota: 100 },
        }),
      });

      const { result } = renderHook(() => useFileDrop(defaultOptions));
      const event = createMockDragEvent([createMockFile('test.txt', 100)]);

      await act(async () => {
        await result.current.handleFileDrop(event);
      });

      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('85%'));
    });
  });
});
