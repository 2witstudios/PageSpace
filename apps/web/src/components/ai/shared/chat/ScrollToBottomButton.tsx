/**
 * ScrollToBottomButton - Floating button that appears when user scrolls up in chat
 * Shows a down arrow that scrolls to the bottom of the message list when clicked.
 */

import React, { useState, useEffect, useCallback, RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ScrollToBottomButtonProps {
  /** Ref to the scrollable container element */
  scrollRef: RefObject<HTMLElement | null>;
  /** Optional className for positioning overrides */
  className?: string;
  /** Threshold in pixels from bottom to consider "at bottom" (default: 100) */
  threshold?: number;
}

/**
 * Floating button that appears when user has scrolled up from the bottom of a chat.
 * Clicking the button smoothly scrolls to the bottom of the container.
 */
export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  scrollRef,
  className,
  threshold = 100,
}) => {
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Check if scrolled to bottom
  const checkIfAtBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setIsAtBottom(distanceFromBottom <= threshold);
  }, [scrollRef, threshold]);

  // Scroll to bottom handler
  const scrollToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, [scrollRef]);

  // Set up scroll listener
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    // Check initial state
    checkIfAtBottom();

    // Listen for scroll events
    container.addEventListener('scroll', checkIfAtBottom, { passive: true });

    // Also watch for content changes via ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      // Small delay to let content render
      requestAnimationFrame(checkIfAtBottom);
    });

    // Observe the scroll container's first child (content wrapper)
    const contentWrapper = container.firstElementChild;
    if (contentWrapper) {
      resizeObserver.observe(contentWrapper);
    }

    return () => {
      container.removeEventListener('scroll', checkIfAtBottom);
      resizeObserver.disconnect();
    };
  }, [scrollRef, checkIfAtBottom]);

  // Don't render if at bottom
  if (isAtBottom) {
    return null;
  }

  return (
    <Button
      variant="secondary"
      size="icon"
      onClick={scrollToBottom}
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
