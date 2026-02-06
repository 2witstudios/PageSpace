'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

interface PerformanceMetrics {
  route: string;
  loadTime: number;
  timestamp: number;
}

const METRICS_STORAGE_KEY = 'pagespace-performance-metrics';
const MAX_METRICS_STORED = 50;
const ENABLE_PERFORMANCE_MONITORING = process.env.NODE_ENV === 'production';

export function usePerformanceMonitor() {
  const pathname = usePathname();
  const navigationStartTime = useRef<number | null>(null);
  const currentRoute = useRef<string | null>(null);

  // Record navigation start
  useEffect(() => {
    if (!ENABLE_PERFORMANCE_MONITORING) return;
    
    navigationStartTime.current = performance.now();
    currentRoute.current = pathname;
  }, [pathname]);

  // Record navigation end
  useEffect(() => {
    if (!ENABLE_PERFORMANCE_MONITORING) return;
    
    if (navigationStartTime.current && currentRoute.current === pathname) {
      const loadTime = performance.now() - navigationStartTime.current;
      
      // Only record meaningful navigation times (> 10ms to filter out same-page updates)
      if (loadTime > 10) {
        recordMetric({
          route: pathname,
          loadTime,
          timestamp: Date.now()
        });
        
        // Log slow navigations in development
        if (process.env.NODE_ENV === 'development' && loadTime > 500) {
          console.warn(`🐌 Slow navigation to ${pathname}: ${loadTime.toFixed(2)}ms`);
        }
      }
      
      navigationStartTime.current = null;
    }
  }, [pathname]);

  const recordMetric = (metric: PerformanceMetrics) => {
    try {
      const stored = localStorage.getItem(METRICS_STORAGE_KEY);
      const metrics: PerformanceMetrics[] = stored ? JSON.parse(stored) : [];
      
      metrics.unshift(metric);
      
      // Keep only the most recent metrics
      if (metrics.length > MAX_METRICS_STORED) {
        metrics.splice(MAX_METRICS_STORED);
      }
      
      localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
    } catch (error) {
      console.error('Failed to store performance metric:', error);
    }
  };

  const getMetrics = (): PerformanceMetrics[] => {
    try {
      const stored = localStorage.getItem(METRICS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Failed to retrieve performance metrics:', error);
      return [];
    }
  };

  const getAverageLoadTime = (route?: string): number => {
    const metrics = getMetrics();
    const filteredMetrics = route 
      ? metrics.filter(m => m.route === route)
      : metrics;
    
    if (filteredMetrics.length === 0) return 0;
    
    const totalTime = filteredMetrics.reduce((sum, m) => sum + m.loadTime, 0);
    return totalTime / filteredMetrics.length;
  };

  const clearMetrics = () => {
    try {
      localStorage.removeItem(METRICS_STORAGE_KEY);
    } catch (error) {
      console.error('Failed to clear performance metrics:', error);
    }
  };

  return {
    getMetrics,
    getAverageLoadTime,
    clearMetrics,
    recordMetric
  };
}

