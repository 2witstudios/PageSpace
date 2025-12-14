/**
 * useAiUsage Hook Tests
 * Tests for AI usage data fetching with SWR
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

// Track useSWR calls
const mockUseSWR = vi.hoisted(() => vi.fn());

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
  default: (key: string | null, fetcher: (...args: unknown[]) => unknown, config?: object) => {
    mockUseSWR(key, fetcher, config);
    return {
      data: key ? mockSWRState.data : undefined,
      error: mockSWRState.error,
      mutate: mockMutate,
      isLoading: key !== null && mockSWRState.data === undefined && mockSWRState.error === undefined,
    };
  },
}));

import { useAiUsage, usePageAiUsage } from '../useAiUsage';

// Helper to create mock API response
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
    mockUseSWR.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR key generation', () => {
    it('given a conversationId, should generate correct SWR key', () => {
      renderHook(() => useAiUsage('conv-123'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/ai/global/conv-123/usage',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given null conversationId, should pass null as SWR key', () => {
      renderHook(() => useAiUsage(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given undefined conversationId, should pass null as SWR key', () => {
      renderHook(() => useAiUsage(undefined));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given conversationId with special characters, should encode it', () => {
      renderHook(() => useAiUsage('conv with spaces'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/ai/global/conv%20with%20spaces/usage',
        expect.any(Function),
        expect.any(Object)
      );
    });
  });

  describe('SWR configuration', () => {
    it('should use default refresh interval of 15000ms', () => {
      renderHook(() => useAiUsage('conv-123'));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.refreshInterval).toBe(15000);
    });

    it('given custom refresh interval, should use it', () => {
      renderHook(() => useAiUsage('conv-123', 5000));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.refreshInterval).toBe(5000);
    });

    it('should disable revalidateOnFocus', () => {
      renderHook(() => useAiUsage('conv-123'));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.revalidateOnFocus).toBe(false);
    });

    it('should set dedupingInterval to 2000ms', () => {
      renderHook(() => useAiUsage('conv-123'));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.dedupingInterval).toBe(2000);
    });
  });

  describe('return values', () => {
    it('given data is loaded, should return mapped usage data', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.usage).toBeDefined();
      expect(result.current.usage?.billing.inputTokens).toBe(1000);
      expect(result.current.usage?.billing.outputTokens).toBe(500);
      expect(result.current.usage?.billing.totalTokens).toBe(1500);
      expect(result.current.usage?.billing.cost).toBe(0.05);
    });

    it('given context data, should map it correctly', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.usage?.context.currentSize).toBe(2000);
      expect(result.current.usage?.context.messagesInContext).toBe(10);
      expect(result.current.usage?.context.windowSize).toBe(128000);
      expect(result.current.usage?.context.usagePercent).toBe(1.56);
      expect(result.current.usage?.context.wasTruncated).toBe(false);
    });

    it('given no context data (legacy), should compute fallback values', () => {
      mockSWRState.data = createMockUsageResponse({
        summary: {
          billing: {
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalTokens: 1500,
            totalCost: 0.05,
          },
          context: null, // Legacy data without context
          mostRecentModel: 'gpt-4',
          mostRecentProvider: 'openai',
        },
      });

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.usage?.context.currentSize).toBe(1000); // Falls back to totalInputTokens
      expect(result.current.usage?.context.messagesInContext).toBe(0);
      expect(result.current.usage?.context.wasTruncated).toBe(false);
    });

    it('given logs in response, should return them', () => {
      const mockLogs = [
        { id: 'log-1', timestamp: new Date(), inputTokens: 100 },
        { id: 'log-2', timestamp: new Date(), inputTokens: 200 },
      ];
      mockSWRState.data = createMockUsageResponse({ logs: mockLogs });

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.logs).toEqual(mockLogs);
    });

    it('given no data, should return empty logs array', () => {
      mockSWRState.data = undefined;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.logs).toEqual([]);
      expect(result.current.usage).toBeNull();
    });

    it('given error, should return isError', () => {
      const error = new Error('Failed to fetch');
      mockSWRState.error = error;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.isError).toBe(error);
    });

    it('should expose mutate function', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.mutate).toBe(mockMutate);
    });
  });

  describe('isLoading state', () => {
    it('given no data and no error and valid key, should be loading', () => {
      mockSWRState.data = undefined;
      mockSWRState.error = undefined;

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.isLoading).toBe(true);
    });

    it('given data loaded, should not be loading', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.isLoading).toBe(false);
    });

    it('given null key, should not be loading', () => {
      mockSWRState.data = undefined;

      const { result } = renderHook(() => useAiUsage(null));

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('model and provider info', () => {
    it('given model and provider in response, should include them', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => useAiUsage('conv-123'));

      expect(result.current.usage?.model).toBe('gpt-4');
      expect(result.current.usage?.provider).toBe('openai');
    });

    it('given no model info, should default to unknown', () => {
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

      expect(result.current.usage?.model).toBe('unknown');
      expect(result.current.usage?.provider).toBe('unknown');
    });
  });
});

describe('usePageAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.data = undefined;
    mockSWRState.error = undefined;
    mockUseSWR.mockClear();
  });

  describe('SWR key generation', () => {
    it('given a pageId, should generate page-specific SWR key', () => {
      renderHook(() => usePageAiUsage('page-123'));

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/pages/page-123/ai-usage',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given null pageId, should pass null as SWR key', () => {
      renderHook(() => usePageAiUsage(null));

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });
  });

  describe('return values', () => {
    it('given data is loaded, should return mapped usage data', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => usePageAiUsage('page-123'));

      expect(result.current.usage).toBeDefined();
      expect(result.current.usage?.billing.inputTokens).toBe(1000);
    });

    it('should use same data mapping as useAiUsage', () => {
      mockSWRState.data = createMockUsageResponse();

      const { result } = renderHook(() => usePageAiUsage('page-123'));

      expect(result.current.usage?.context.currentSize).toBe(2000);
      expect(result.current.usage?.model).toBe('gpt-4');
    });
  });

  describe('SWR configuration', () => {
    it('should use same configuration as useAiUsage', () => {
      renderHook(() => usePageAiUsage('page-123'));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.refreshInterval).toBe(15000);
      expect(swrConfig?.revalidateOnFocus).toBe(false);
      expect(swrConfig?.dedupingInterval).toBe(2000);
    });

    it('given custom refresh interval, should use it', () => {
      renderHook(() => usePageAiUsage('page-123', 30000));

      const swrConfig = mockUseSWR.mock.calls[0][2];
      expect(swrConfig?.refreshInterval).toBe(30000);
    });
  });
});
