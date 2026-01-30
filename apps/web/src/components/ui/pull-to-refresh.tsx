'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useMobile } from '@/hooks/useMobile';
import { useTouchDevice } from '@/hooks/useTouchDevice';

interface PullToRefreshProps {
  children: React.ReactNode;
  /** Direction to pull from: 'top' for pull-down, 'bottom' for pull-up */
  direction?: 'top' | 'bottom';
  /** Callback when refresh is triggered */
  onRefresh: () => Promise<void>;
  /** Disable pull-to-refresh entirely */
  disabled?: boolean;
  /** Distance in pixels required to trigger refresh (default: 60) */
  threshold?: number;
  /** Additional class name for the wrapper */
  className?: string;
}

/**
 * Wrapper component that adds pull-to-refresh functionality to scrollable content.
 * Automatically disabled on non-mobile devices.
 *
 * IMPORTANT: The first child must be a scrollable element (e.g., CustomScrollArea).
 * PullToRefresh will attach its ref and touch handlers to the child.
 */
export function PullToRefresh({
  children,
  direction = 'top',
  onRefresh,
  disabled = false,
  threshold = 60,
  className,
}: PullToRefreshProps) {
  const isMobile = useMobile();
  const isTouchDevice = useTouchDevice();
  const isEnabled = isMobile && isTouchDevice && !disabled;

  const { pullDistance, isPulling, isRefreshing, hasReachedThreshold, touchHandlers, containerRef } =
    usePullToRefresh({
      direction,
      threshold,
      onRefresh,
      disabled: !isEnabled,
    });

  // Calculate spinner state
  const showSpinner = pullDistance > 0 || isRefreshing;
  const spinnerOpacity = Math.min(pullDistance / threshold, 1);
  const spinnerRotation = isRefreshing ? 0 : (pullDistance / threshold) * 360;
  const spinnerScale = Math.min(0.5 + (pullDistance / threshold) * 0.5, 1);

  // If not enabled, just render children without wrapper
  if (!isEnabled) {
    return <>{children}</>;
  }

  // Clone the child element to add ref and touch handlers
  const childElement = React.Children.only(children) as React.ReactElement<{
    ref?: React.Ref<HTMLElement>;
    onTouchStart?: (e: React.TouchEvent) => void;
    onTouchMove?: (e: React.TouchEvent) => void;
    onTouchEnd?: () => void;
    style?: React.CSSProperties;
    className?: string;
  }>;

  const enhancedChild = React.cloneElement(childElement, {
    ref: containerRef as React.Ref<HTMLElement>,
    onTouchStart: touchHandlers.onTouchStart,
    onTouchMove: touchHandlers.onTouchMove,
    onTouchEnd: touchHandlers.onTouchEnd,
    style: {
      ...childElement.props.style,
      // Add visual offset when pulling
      transform: direction === 'top' && pullDistance > 0 ? `translateY(${pullDistance}px)` : undefined,
      transition: isPulling ? 'none' : 'transform 0.2s ease-out',
    },
  });

  return (
    <div className={cn('relative h-full overflow-hidden', className)}>
      {/* Top spinner indicator */}
      {direction === 'top' && (
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none',
            'transition-opacity duration-150'
          )}
          style={{
            top: 8,
            opacity: showSpinner ? spinnerOpacity : 0,
            transform: `translateX(-50%) translateY(${Math.max(0, pullDistance - 20)}px) scale(${spinnerScale})`,
          }}
        >
          <div
            className={cn(
              'flex items-center justify-center w-10 h-10 rounded-full',
              'bg-background/95 border shadow-lg backdrop-blur-sm',
              hasReachedThreshold && 'border-primary'
            )}
          >
            <Loader2
              className={cn(
                'w-5 h-5 text-muted-foreground',
                isRefreshing && 'animate-spin',
                hasReachedThreshold && 'text-primary'
              )}
              style={{
                transform: !isRefreshing ? `rotate(${spinnerRotation}deg)` : undefined,
              }}
            />
          </div>
        </div>
      )}

      {/* Scrollable content (enhanced child with touch handlers) */}
      {enhancedChild}

      {/* Bottom spinner for pull-up direction */}
      {direction === 'bottom' && (
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none',
            'transition-opacity duration-150'
          )}
          style={{
            bottom: 8,
            opacity: showSpinner ? spinnerOpacity : 0,
            transform: `translateX(-50%) translateY(${Math.min(0, -(pullDistance - 20))}px) scale(${spinnerScale})`,
          }}
        >
          <div
            className={cn(
              'flex items-center justify-center w-10 h-10 rounded-full',
              'bg-background/95 border shadow-lg backdrop-blur-sm',
              hasReachedThreshold && 'border-primary'
            )}
          >
            <Loader2
              className={cn(
                'w-5 h-5 text-muted-foreground',
                isRefreshing && 'animate-spin',
                hasReachedThreshold && 'text-primary'
              )}
              style={{
                transform: !isRefreshing ? `rotate(${spinnerRotation}deg)` : undefined,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
