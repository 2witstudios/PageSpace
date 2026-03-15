import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockUseSWR = vi.hoisted(() => vi.fn());
const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
const mockPatch = vi.hoisted(() => vi.fn());
const mockDel = vi.hoisted(() => vi.fn());
const mockIsEditingActive = vi.hoisted(() => vi.fn(() => false));
const mockMutate = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({
  default: mockUseSWR,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
  patch: mockPatch,
  del: mockDel,
}));

vi.mock('@/stores/useEditingStore', () => ({
  isEditingActive: mockIsEditingActive,
}));

import { useWorkflows } from '../useWorkflows';

describe('useWorkflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseSWR.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });

    mockPost.mockResolvedValue({ success: true });
    mockPatch.mockResolvedValue({ success: true });
    mockDel.mockResolvedValue(undefined);
  });

  describe('SWR key construction', () => {
    it('should construct correct SWR key with driveId', () => {
      renderHook(() => useWorkflows('drive-123'));

      expect(mockUseSWR).toHaveBeenCalled();
      const [key] = mockUseSWR.mock.calls[0];
      expect(key).toBe('/api/workflows?driveId=drive-123');
    });

    it('should return null key without driveId', () => {
      renderHook(() => useWorkflows(''));

      expect(mockUseSWR).toHaveBeenCalled();
      const [key] = mockUseSWR.mock.calls[0];
      expect(key).toBeNull();
    });
  });

  describe('return values', () => {
    it('should return empty workflows array initially', () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
      });

      const { result } = renderHook(() => useWorkflows('drive-123'));

      expect(result.current.workflows).toEqual([]);
    });

    it('should return workflows when data is available', () => {
      const mockWorkflows = [
        { id: 'wf-1', name: 'Workflow 1', driveId: 'drive-123' },
        { id: 'wf-2', name: 'Workflow 2', driveId: 'drive-123' },
      ];

      mockUseSWR.mockReturnValue({
        data: mockWorkflows,
        error: undefined,
        isLoading: false,
        mutate: mockMutate,
      });

      const { result } = renderHook(() => useWorkflows('drive-123'));

      expect(result.current.workflows).toEqual(mockWorkflows);
    });

    it('should expose isLoading state', () => {
      mockUseSWR.mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: true,
        mutate: mockMutate,
      });

      const { result } = renderHook(() => useWorkflows('drive-123'));

      expect(result.current.isLoading).toBe(true);
    });

    it('should expose error state', () => {
      const error = new Error('Failed to fetch');
      mockUseSWR.mockReturnValue({
        data: undefined,
        error,
        isLoading: false,
        mutate: mockMutate,
      });

      const { result } = renderHook(() => useWorkflows('drive-123'));

      expect(result.current.error).toBe(error);
    });
  });

  describe('runWorkflow', () => {
    it('should call post with correct endpoint', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.runWorkflow('wf-1');
      });

      expect(mockPost).toHaveBeenCalledWith('/api/workflows/wf-1/run');
    });

    it('should call mutate after running workflow', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.runWorkflow('wf-1');
      });

      expect(mockMutate).toHaveBeenCalled();
    });

    it('should return the result from post', async () => {
      const expectedResult = { success: true, responseText: 'Done' };
      mockPost.mockResolvedValue(expectedResult);

      const { result } = renderHook(() => useWorkflows('drive-123'));

      let runResult: unknown;
      await act(async () => {
        runResult = await result.current.runWorkflow('wf-1');
      });

      expect(runResult).toEqual(expectedResult);
    });
  });

  describe('toggleWorkflow', () => {
    it('should call patch with correct endpoint and payload', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.toggleWorkflow('wf-1', true);
      });

      expect(mockPatch).toHaveBeenCalledWith('/api/workflows/wf-1', { isEnabled: true });
    });

    it('should call patch with isEnabled=false when disabling', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.toggleWorkflow('wf-1', false);
      });

      expect(mockPatch).toHaveBeenCalledWith('/api/workflows/wf-1', { isEnabled: false });
    });

    it('should call mutate after toggling workflow', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.toggleWorkflow('wf-1', true);
      });

      expect(mockMutate).toHaveBeenCalled();
    });
  });

  describe('deleteWorkflow', () => {
    it('should call del with correct endpoint', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.deleteWorkflow('wf-1');
      });

      expect(mockDel).toHaveBeenCalledWith('/api/workflows/wf-1');
    });

    it('should call mutate after deleting workflow', async () => {
      const { result } = renderHook(() => useWorkflows('drive-123'));

      await act(async () => {
        await result.current.deleteWorkflow('wf-1');
      });

      expect(mockMutate).toHaveBeenCalled();
    });
  });

  describe('SWR options', () => {
    it('should pass isPaused function that checks editing state', () => {
      renderHook(() => useWorkflows('drive-123'));

      const [, , options] = mockUseSWR.mock.calls[0];

      // isPaused should return false initially (hasLoadedRef is false)
      expect(options.isPaused()).toBe(false);
    });

    it('should set revalidateOnFocus to false', () => {
      renderHook(() => useWorkflows('drive-123'));

      const [, , options] = mockUseSWR.mock.calls[0];

      expect(options.revalidateOnFocus).toBe(false);
    });

    it('should set refreshInterval to 300000', () => {
      renderHook(() => useWorkflows('drive-123'));

      const [, , options] = mockUseSWR.mock.calls[0];

      expect(options.refreshInterval).toBe(300000);
    });
  });
});
