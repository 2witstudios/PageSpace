'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import { triggerHaptic } from '@/lib/haptics';

export interface UsePullToRefreshOptions {
  /** Direction to pull from: 'top' for pull-down, 'bottom' for pull-up */
  direction: 'top' | 'bottom';
  /** Distance in pixels required to trigger refresh (default: 60) */
  threshold?: number;
  /** Callback when refresh is triggered */
  onRefresh: () => Promise<void>;
  /** Disable the pull-to-refresh behavior */
  disabled?: boolean;
  /** Resistance factor - higher = more resistance (default: 2.5) */
  resistance?: number;
}

export interface UsePullToRefreshReturn {
  /** Current pull distance (0 when not pulling) */
  pullDistance: number;
  /** Whether currently in pulling phase */
  isPulling: boolean;
  /** Whether refresh is in progress */
  isRefreshing: boolean;
  /** Whether threshold has been reached */
  hasReachedThreshold: boolean;
  /** Touch event handlers to attach to the scrollable element */
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  /** Ref to attach to the scrollable container */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * Hook for implementing pull-to-refresh functionality.
 * Supports both pull-down (for lists) and pull-up (for chat) directions.
 */
export function usePullToRefresh({
  direction,
  threshold = 60,
  onRefresh,
  disabled = false,
  resistance = 2.5,
}: UsePullToRefreshOptions): UsePullToRefreshReturn {
  const containerRef = useRef<HTMLElement | null>(null);
  const startYRef = useRef<number>(0);
  const startScrollRef = useRef<number>(0);
  const isPullingRef = useRef(false);
  const hasTriggeredHapticRef = useRef(false);

  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasReachedThreshold, setHasReachedThreshold] = useState(false);

  const isAtEdge = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;

    if (direction === 'top') {
      return container.scrollTop <= 0;
    } else {
      // For bottom, check if scrolled to the end
      const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      return scrollBottom <= 1; // Allow 1px tolerance for rounding
    }
  }, [direction]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || isRefreshing) return;

      const touch = e.touches[0];
      startYRef.current = touch.clientY;
      startScrollRef.current = containerRef.current?.scrollTop ?? 0;
      hasTriggeredHapticRef.current = false;
    },
    [disabled, isRefreshing]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || isRefreshing) return;

      const touch = e.touches[0];
      const deltaY = touch.clientY - startYRef.current;

      // Determine if we should start pulling based on direction and position
      const shouldStartPulling =
        direction === 'top' ? deltaY > 0 && isAtEdge() : deltaY < 0 && isAtEdge();

      if (!isPullingRef.current && shouldStartPulling) {
        isPullingRef.current = true;
        setIsPulling(true);
        // Update start position to current position when we start pulling
        startYRef.current = touch.clientY;
      }

      if (isPullingRef.current) {
        const rawDistance = direction === 'top' ? deltaY : -deltaY;

        if (rawDistance > 0) {
          // Apply resistance to the pull distance (diminishing returns)
          const resistedDistance = Math.min(
            rawDistance / resistance,
            threshold * 2 // Cap at 2x threshold
          );

          setPullDistance(resistedDistance);

          // Check if threshold reached
          const thresholdReached = resistedDistance >= threshold;
          setHasReachedThreshold(thresholdReached);

          // Trigger haptic when crossing threshold
          if (thresholdReached && !hasTriggeredHapticRef.current) {
            hasTriggeredHapticRef.current = true;
            triggerHaptic('medium');
          } else if (!thresholdReached && hasTriggeredHapticRef.current) {
            hasTriggeredHapticRef.current = false;
            triggerHaptic('light');
          }

          // Prevent scrolling while pulling
          e.preventDefault();
        } else {
          // User is scrolling in opposite direction, cancel pull
          isPullingRef.current = false;
          setIsPulling(false);
          setPullDistance(0);
          setHasReachedThreshold(false);
        }
      }
    },
    [disabled, isRefreshing, direction, isAtEdge, resistance, threshold]
  );

  const onTouchEnd = useCallback(async () => {
    if (!isPullingRef.current) return;

    const shouldRefresh = pullDistance >= threshold && !isRefreshing;

    isPullingRef.current = false;
    setIsPulling(false);
    setHasReachedThreshold(false);

    if (shouldRefresh) {
      setIsRefreshing(true);
      setPullDistance(threshold); // Keep indicator visible during refresh

      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
        triggerHaptic('light');
      }
    } else {
      // Snap back animation handled by CSS transition
      setPullDistance(0);
    }
  }, [pullDistance, threshold, isRefreshing, onRefresh]);

  const onTouchCancel = useCallback(() => {
    if (!isPullingRef.current) return;
    isPullingRef.current = false;
    setIsPulling(false);
    setHasReachedThreshold(false);
    setPullDistance(0);
  }, []);

  return {
    pullDistance,
    isPulling,
    isRefreshing,
    hasReachedThreshold,
    touchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
    },
    containerRef,
  };
}
