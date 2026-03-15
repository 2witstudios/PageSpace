import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// The hook checks process.env.NODE_ENV === 'production' at module level.
// Since vitest runs in 'test' mode, ENABLE_PERFORMANCE_MONITORING will be false,
// but we can still test the utility functions (getMetrics, getAverageLoadTime, clearMetrics, recordMetric)
// since they work independently of the flag.

const METRICS_STORAGE_KEY = 'pagespace-performance-metrics';

describe('usePerformanceMonitor', () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      return mockStorage[key] ?? null;
    });

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      mockStorage[key] = value;
    });

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      delete mockStorage[key];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getMetrics', () => {
    it('should return empty array when no metrics stored', async () => {
      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const metrics = result.current.getMetrics();
      expect(metrics).toEqual([]);
    });

    it('should return stored metrics', async () => {
      const storedMetrics = [
        { route: '/dashboard', loadTime: 150, timestamp: 1000 },
        { route: '/settings', loadTime: 200, timestamp: 2000 },
      ];
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(storedMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const metrics = result.current.getMetrics();
      expect(metrics).toEqual(storedMetrics);
    });

    it('should return empty array when localStorage throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const metrics = result.current.getMetrics();
      expect(metrics).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('getAverageLoadTime', () => {
    it('should return 0 when no metrics exist', async () => {
      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      expect(result.current.getAverageLoadTime()).toBe(0);
    });

    it('should calculate average across all metrics when no route specified', async () => {
      const storedMetrics = [
        { route: '/a', loadTime: 100, timestamp: 1000 },
        { route: '/b', loadTime: 200, timestamp: 2000 },
        { route: '/c', loadTime: 300, timestamp: 3000 },
      ];
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(storedMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      expect(result.current.getAverageLoadTime()).toBe(200);
    });

    it('should calculate average for specific route', async () => {
      const storedMetrics = [
        { route: '/dashboard', loadTime: 100, timestamp: 1000 },
        { route: '/dashboard', loadTime: 300, timestamp: 2000 },
        { route: '/settings', loadTime: 500, timestamp: 3000 },
      ];
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(storedMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      expect(result.current.getAverageLoadTime('/dashboard')).toBe(200);
    });

    it('should return 0 when route has no metrics', async () => {
      const storedMetrics = [
        { route: '/dashboard', loadTime: 100, timestamp: 1000 },
      ];
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(storedMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      expect(result.current.getAverageLoadTime('/nonexistent')).toBe(0);
    });
  });

  describe('clearMetrics', () => {
    it('should remove metrics from localStorage', async () => {
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify([
        { route: '/test', loadTime: 100, timestamp: 1000 },
      ]);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      result.current.clearMetrics();

      expect(mockStorage[METRICS_STORAGE_KEY]).toBeUndefined();
    });

    it('should handle errors gracefully when clearing', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      // Should not throw
      result.current.clearMetrics();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('recordMetric', () => {
    it('should store a metric in localStorage', async () => {
      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const metric = { route: '/test', loadTime: 150, timestamp: Date.now() };
      result.current.recordMetric(metric);

      const stored = JSON.parse(mockStorage[METRICS_STORAGE_KEY]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual(metric);
    });

    it('should prepend new metrics (most recent first)', async () => {
      const existingMetrics = [
        { route: '/old', loadTime: 100, timestamp: 1000 },
      ];
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(existingMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const newMetric = { route: '/new', loadTime: 200, timestamp: 2000 };
      result.current.recordMetric(newMetric);

      const stored = JSON.parse(mockStorage[METRICS_STORAGE_KEY]);
      expect(stored).toHaveLength(2);
      expect(stored[0]).toEqual(newMetric);
      expect(stored[1]).toEqual(existingMetrics[0]);
    });

    it('should cap stored metrics at MAX_METRICS_STORED (50)', async () => {
      // Fill with 50 existing metrics
      const existingMetrics = Array.from({ length: 50 }, (_, i) => ({
        route: `/route-${i}`,
        loadTime: i * 10,
        timestamp: i * 1000,
      }));
      mockStorage[METRICS_STORAGE_KEY] = JSON.stringify(existingMetrics);

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      const newMetric = { route: '/newest', loadTime: 999, timestamp: 99000 };
      result.current.recordMetric(newMetric);

      const stored = JSON.parse(mockStorage[METRICS_STORAGE_KEY]);
      expect(stored).toHaveLength(50);
      expect(stored[0]).toEqual(newMetric);
      // The last old metric should have been dropped
      expect(stored[49].route).toBe('/route-48');
    });

    it('should handle errors gracefully when recording', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      // Should not throw
      result.current.recordMetric({ route: '/test', loadTime: 100, timestamp: 1000 });
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('return shape', () => {
    it('should return all expected methods', async () => {
      const { usePerformanceMonitor } = await import('../usePerformanceMonitor');
      const { result } = renderHook(() => usePerformanceMonitor());

      expect(typeof result.current.getMetrics).toBe('function');
      expect(typeof result.current.getAverageLoadTime).toBe('function');
      expect(typeof result.current.clearMetrics).toBe('function');
      expect(typeof result.current.recordMetric).toBe('function');
    });
  });
});

describe('useRenderPerformance', () => {
  it('should return renderCount', async () => {
    const { useRenderPerformance } = await import('../usePerformanceMonitor');
    const { result } = renderHook(() => useRenderPerformance('TestComponent'));

    expect(result.current).toHaveProperty('renderCount');
    expect(typeof result.current.renderCount).toBe('number');
  });

  it('should track render count via ref', async () => {
    const { useRenderPerformance } = await import('../usePerformanceMonitor');
    const { result, rerender } = renderHook(() => useRenderPerformance('TestComponent'));

    const initialCount = result.current.renderCount;

    rerender();

    // Note: renderCount uses a ref, so the returned value reflects the count at render time
    // The ref increments in the effect, so it may be one behind
    expect(typeof result.current.renderCount).toBe('number');
    expect(result.current.renderCount).toBeGreaterThanOrEqual(initialCount);
  });
});
