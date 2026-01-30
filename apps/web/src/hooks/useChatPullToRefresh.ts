'use client';

import { useCallback, useRef, useState } from 'react';
import { triggerHaptic } from '@/lib/haptics';
import { useMobile } from './useMobile';
import { useTouchDevice } from './useTouchDevice';
import { useEditingStore } from '@/stores/useEditingStore';

export interface UseChatPullToRefreshOptions {
  /** Whether the refresh is currently disabled (e.g., during streaming) */
  disabled?: boolean;
  /** Threshold in pixels to trigger refresh (default: 60) */
  threshold?: number;
  /** Callback when refresh is triggered - should fetch new messages */
  onRefresh: () => Promise<void>;
}

export interface UseChatPullToRefreshReturn {
  /** Current pull distance (for spinner animation) */
  pullDistance: number;
  /** Whether currently pulling */
  isPulling: boolean;
  /** Whether refresh is in progress */
  isRefreshing: boolean;
  /** Whether threshold has been reached */
  hasReachedThreshold: boolean;
  /** Touch event handlers for bottom pull-up detection */
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  /** Check if container is scrolled to bottom */
  isAtBottom: (container: HTMLElement | null) => boolean;
}

/**
 * Hook for pull-up refresh in chat views.
 * Designed to work with use-stick-to-bottom.
 * Detects over-scroll at the bottom and triggers a refresh.
 */
export function useChatPullToRefresh({
  disabled = false,
  threshold = 60,
  onRefresh,
}: UseChatPullToRefreshOptions): UseChatPullToRefreshReturn {
  const isMobile = useMobile();
  const isTouchDevice = useTouchDevice();

  const startYRef = useRef<number>(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const isPullingRef = useRef(false);
  const hasTriggeredHapticRef = useRef(false);
  const lastScrollBottomRef = useRef<number>(0);

  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasReachedThreshold, setHasReachedThreshold] = useState(false);

  const isEnabled = isMobile && isTouchDevice && !disabled;

  const isAtBottom = useCallback((container: HTMLElement | null): boolean => {
    if (!container) return false;
    const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return scrollBottom <= 1; // 1px tolerance for rounding
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isEnabled || isRefreshing) return;

      // Check if streaming is active
      if (useEditingStore.getState().isAnyActive()) return;

      const touch = e.touches[0];
      startYRef.current = touch.clientY;

      // Find the scroll container (Conversation component)
      const target = e.currentTarget as HTMLElement;
      const scrollContainer = target.querySelector('[data-slot="scroll-area-viewport"]') ||
        target.closest('[data-slot="scroll-area-viewport"]') ||
        target;
      containerRef.current = scrollContainer as HTMLElement;

      if (containerRef.current) {
        lastScrollBottomRef.current =
          containerRef.current.scrollHeight -
          containerRef.current.scrollTop -
          containerRef.current.clientHeight;
      }

      hasTriggeredHapticRef.current = false;
    },
    [isEnabled, isRefreshing]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isEnabled || isRefreshing) return;
      if (useEditingStore.getState().isAnyActive()) return;

      const touch = e.touches[0];
      const deltaY = startYRef.current - touch.clientY; // Positive when pulling up

      const container = containerRef.current;
      if (!container) return;

      // Check if we're at the bottom
      const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const wasAtBottom = lastScrollBottomRef.current <= 1;
      const atBottom = scrollBottom <= 1;

      // Only start pulling if we started at bottom and are pulling up
      const shouldStartPulling = deltaY > 0 && wasAtBottom && atBottom;

      if (!isPullingRef.current && shouldStartPulling) {
        isPullingRef.current = true;
        setIsPulling(true);
        startYRef.current = touch.clientY;
      }

      if (isPullingRef.current) {
        const rawDistance = Math.max(0, startYRef.current - touch.clientY);

        // Apply resistance (diminishing returns)
        const resistedDistance = Math.min(rawDistance / 2.5, threshold * 2);

        setPullDistance(resistedDistance);

        // Check threshold
        const thresholdReached = resistedDistance >= threshold;
        setHasReachedThreshold(thresholdReached);

        // Haptic feedback at threshold
        if (thresholdReached && !hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = true;
          triggerHaptic('medium');
        } else if (!thresholdReached && hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = false;
          triggerHaptic('light');
        }
      }
    },
    [isEnabled, isRefreshing, threshold]
  );

  const onTouchEnd = useCallback(async () => {
    if (!isPullingRef.current) return;

    const shouldRefresh = pullDistance >= threshold && !isRefreshing;

    isPullingRef.current = false;
    setIsPulling(false);
    setHasReachedThreshold(false);

    if (shouldRefresh) {
      setIsRefreshing(true);
      setPullDistance(threshold); // Keep indicator visible

      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
        triggerHaptic('light');
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, threshold, isRefreshing, onRefresh]);

  return {
    pullDistance,
    isPulling,
    isRefreshing,
    hasReachedThreshold,
    touchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    isAtBottom,
  };
}
