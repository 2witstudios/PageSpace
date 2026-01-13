/**
 * ScrollToBottomButton - Floating button that appears when user scrolls up in chat
 * Shows a down arrow that scrolls to the bottom of the message list when clicked.
 *
 * Designed to be virtualization-compatible:
 * - Can use internal scroll detection (default) OR external control via props
 * - When virtualization is added, pass `isAtBottom` and `onScrollToBottom` from the
 *   virtualization library to override internal behavior
 */

import React, { useState, useEffect, useCallback, RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ScrollToBottomButtonProps {
  /** Ref to the scrollable container element (used for internal scroll detection) */
  scrollRef: RefObject<HTMLElement | null>;
  /** Optional className for positioning overrides */
  className?: string;
  /** Threshold in pixels from bottom to consider "at bottom" (default: 100) */
  threshold?: number;
  /**
   * External control: override internal scroll detection.
   * Use this when integrating with virtualization libraries that track scroll state.
   */
  isAtBottom?: boolean;
  /**
   * External control: custom scroll-to-bottom handler.
   * Use this when virtualization library provides its own scrollToIndex/scrollToBottom.
   */
  onScrollToBottom?: () => void;
}

/**
 * Floating button that appears when user has scrolled up from the bottom of a chat.
 * Clicking the button smoothly scrolls to the bottom of the container.
 *
 * Supports two modes:
 * 1. Internal mode (default): Uses scrollRef to detect position and scroll
 * 2. External mode: Uses isAtBottom and onScrollToBottom props for virtualization
 */
export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  scrollRef,
  className,
  threshold = 100,
  isAtBottom: externalIsAtBottom,
  onScrollToBottom: externalScrollToBottom,
}) => {
  const [internalIsAtBottom, setInternalIsAtBottom] = useState(true);

  // Use external control if provided, otherwise use internal state
  const isExternallyControlled = externalIsAtBottom !== undefined;
  const isAtBottom = isExternallyControlled ? externalIsAtBottom : internalIsAtBottom;

  // Check if scrolled to bottom (internal mode only)
  const checkIfAtBottom = useCallback(() => {
    if (isExternallyControlled) return;

    const container = scrollRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setInternalIsAtBottom(distanceFromBottom <= threshold);
  }, [scrollRef, threshold, isExternallyControlled]);

  // Internal scroll to bottom handler
  const internalScrollToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, [scrollRef]);

  // Use external handler if provided, otherwise use internal
  const handleScrollToBottom = externalScrollToBottom ?? internalScrollToBottom;

  // Set up scroll listener (internal mode only)
  useEffect(() => {
    if (isExternallyControlled) return;

    const container = scrollRef.current;
    if (!container) return;

    // Check initial state
    checkIfAtBottom();

    // Listen for scroll events
    container.addEventListener('scroll', checkIfAtBottom, { passive: true });

    // Also watch for content changes via ResizeObserver
    // Note: With virtualization, this observer may need to be disabled
    // and scroll state should come from the virtualization library instead
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(checkIfAtBottom);
    });

    const contentWrapper = container.firstElementChild;
    if (contentWrapper) {
      resizeObserver.observe(contentWrapper);
    }

    return () => {
      container.removeEventListener('scroll', checkIfAtBottom);
      resizeObserver.disconnect();
    };
  }, [scrollRef, checkIfAtBottom, isExternallyControlled]);

  // Don't render if at bottom
  if (isAtBottom) {
    return null;
  }

  return (
    <Button
      variant="secondary"
      size="icon"
      onClick={handleScrollToBottom}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 z-10',
        'h-8 w-8 rounded-full shadow-lg',
        'bg-background/95 backdrop-blur-sm border',
        'hover:bg-accent transition-all',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
        className
      )}
      aria-label="Scroll to bottom"
    >
      <ChevronDown className="h-4 w-4" />
    </Button>
  );
};

ScrollToBottomButton.displayName = 'ScrollToBottomButton';
