/**
 * useAiUsage Hook Tests
 * Tests for AI usage data fetching with SWR
 *
 * These tests validate observable behavior:
 * - Data mapping from API response to hook return values
 * - Loading and error states
 * - Null/undefined conversationId handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Create hoisted mocks
const { mockFetchWithAuth, mockMutate, mockSWRState } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockMutate: vi.fn(),
  mockSWRState: {
    data: undefined as unknown,
    error: undefined as unknown,
  },
}));

// Mock dependencies with hoisted mocks
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@pagespace/lib/ai-monitoring', () => ({
  getContextWindow: vi.fn((model: string) => {
    const windows: Record<string, number> = {
      'gpt-4': 128000,
      'claude-3-opus': 200000,
      'unknown': 200000,
    };
    return windows[model] || 200000;
  }),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector({ isAnyActive: () => false });
    }
    return { isAnyActive: () => false };
  }),
}));

vi.mock('swr', () => ({
  default: (key: string | null) => {
    return {
      data: key ? mockSWRState.data : undefined,
      error: mockSWRState.error,
      mutate: mockMutate,
      isLoading: key !== null && mockSWRState.data === undefined && mockSWRState.error === undefined,
    };
  },
}));

import { useAiUsage, usePageAiUsage } from '../useAiUsage';

// Helper to create mock API response matching real API shape
const createMockUsageResponse = (overrides = {}) => ({
  logs: [],
  summary: {
    billing: {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalTokens: 1500,
      totalCost: 0.05,
    },
    context: {
      currentContextSize: 2000,
      messagesInContext: 10,
      contextWindowSize: 128000,
      contextUsagePercent: 1.56,
      wasTruncated: false,
    },
    mostRecentModel: 'gpt-4',
    mostRecentProvider: 'openai',
  },
  ...overrides,
});

describe('useAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.data = undefined;
    mockSWRState.error = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('data mapping', () => {
    it('given API returns usage data, should map billing fields correctly', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: billing data correctly mapped
      expect(result.current.usage?.billing.inputTokens).toBe(1000);
      expect(result.current.usage?.billing.outputTokens).toBe(500);
      expect(result.current.usage?.billing.totalTokens).toBe(1500);
      expect(result.current.usage?.billing.cost).toBe(0.05);
    });

    it('given API returns context data, should map context fields correctly', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: context data correctly mapped
      expect(result.current.usage?.context.currentSize).toBe(2000);
      expect(result.current.usage?.context.messagesInContext).toBe(10);
      expect(result.current.usage?.context.windowSize).toBe(128000);
      expect(result.current.usage?.context.usagePercent).toBe(1.56);
      expect(result.current.usage?.context.wasTruncated).toBe(false);
    });

    it('given API returns model info, should map model and provider', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: model info correctly mapped
      expect(result.current.usage?.model).toBe('gpt-4');
      expect(result.current.usage?.provider).toBe('openai');
    });

    it('given API returns logs with ISO timestamps, should include them in response', () => {
      const mockLogs = [
        { id: 'log-1', timestamp: '2024-01-15T10:30:00.000Z', inputTokens: 100, outputTokens: 50 },
        { id: 'log-2', timestamp: '2024-01-15T10:31:00.000Z', inputTokens: 200, outputTokens: 75 },
      ];
      mockSWRState.data = createMockUsageResponse({ logs: mockLogs });

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: logs returned as-is from API
      expect(result.current.logs).toEqual(mockLogs);
      expect(result.current.logs[0].timestamp).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('legacy data handling', () => {
    it('given API returns null context (legacy), should compute fallback values', () => {
      mockSWRState.data = createMockUsageResponse({
        summary: {
          billing: {
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalTokens: 1500,
            totalCost: 0.05,
          },
          context: null,
          mostRecentModel: 'gpt-4',
          mostRecentProvider: 'openai',
        },
      });

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: fallback values computed for legacy responses
      expect(result.current.usage?.context.currentSize).toBe(1000);
      expect(result.current.usage?.context.messagesInContext).toBe(0);
      expect(result.current.usage?.context.wasTruncated).toBe(false);
    });

    it('given API returns null model info, should default to unknown', () => {
      mockSWRState.data = createMockUsageResponse({
        summary: {
          billing: {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            totalCost: 0,
          },
          context: null,
          mostRecentModel: null,
          mostRecentProvider: null,
        },
      });

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: defaults applied for missing model info
      expect(result.current.usage?.model).toBe('unknown');
      expect(result.current.usage?.provider).toBe('unknown');
    });
  });

  describe('loading and error states', () => {
    it('given data is loading, should return isLoading=true', () => {
      mockSWRState.data = undefined;
      mockSWRState.error = undefined;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: loading state exposed
      expect(result.current.isLoading).toBe(true);
      expect(result.current.usage).toBeNull();
    });

    it('given data is loaded, should return isLoading=false', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.isLoading).toBe(false);
      expect(result.current.usage).not.toBeNull();
    });

    it('given API error, should expose error state', () => {
      const error = new Error('Failed to fetch usage data');
      mockSWRState.error = error;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: error exposed
      expect(result.current.isError).toBe(error);
    });

    it('given no data, should return empty logs array', () => {
      mockSWRState.data = undefined;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: safe default for logs
      expect(result.current.logs).toEqual([]);
    });
  });

  describe('null conversationId handling', () => {
    it('given null conversationId, should not fetch and return null usage', () => {
      const { result } = renderHook(() => useAiUsage(null));

      // Observable: null usage when no conversationId (SWR returns undefined, hook maps to null)
      expect(result.current.usage).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it('given undefined conversationId, should not fetch and return null usage', () => {
      const { result } = renderHook(() => useAiUsage(undefined));

      // Observable: null usage when no conversationId
      expect(result.current.usage).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('mutate function', () => {
    it('should expose mutate function for manual revalidation', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      // Observable: mutate function available
      expect(result.current.mutate).toBe(mockMutate);
    });
  });
});

describe('usePageAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.data = undefined;
    mockSWRState.error = undefined;
  });

  describe('data mapping', () => {
    it('given API returns page usage data, should map fields correctly', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => usePageAiUsage('page-123'));

      // Observable: same data mapping as useAiUsage
      expect(result.current.usage?.billing.inputTokens).toBe(1000);
      expect(result.current.usage?.context.currentSize).toBe(2000);
      expect(result.current.usage?.model).toBe('gpt-4');
    });
  });

  describe('null pageId handling', () => {
    it('given null pageId, should not fetch and return null usage', () => {
      const { result } = renderHook(() => usePageAiUsage(null));

      // Observable: null usage when no pageId
      expect(result.current.usage).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('custom refresh interval', () => {
    it('given custom refresh interval, should still return data correctly', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => usePageAiUsage('page-123', 30000));

      // Observable: data still returned with custom interval
      expect(result.current.usage).not.toBeNull();
      expect(result.current.usage?.billing.inputTokens).toBe(1000);
    });
  });
});
