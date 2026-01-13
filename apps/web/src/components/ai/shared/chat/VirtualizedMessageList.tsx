/**
 * VirtualizedMessageList - High-performance virtualized message list
 *
 * Uses @tanstack/react-virtual for windowed rendering of messages.
 * Designed to work with use-stick-to-bottom for pinned scrolling behavior.
 *
 * Features:
 * - Variable height rows with dynamic measurement
 * - Smooth scrolling with overscan
 * - Works with both full MessageRenderer and CompactMessageRenderer
 * - Integrates with use-stick-to-bottom scroll context
 */

import React, { useRef, useCallback, useEffect, memo } from 'react';
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual';
import { UIMessage } from 'ai';

export interface VirtualizedMessageListProps<T extends UIMessage = UIMessage> {
  /** Messages to render */
  messages: T[];
  /** Render function for each message */
  renderMessage: (message: T, index: number) => React.ReactNode;
  /** Ref to the scroll container element (from use-stick-to-bottom context) */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Optional callback when scrolled near top (for loading older messages) */
  onScrollNearTop?: () => void;
  /** Whether older messages are currently loading */
  isLoadingOlder?: boolean;
  /** Estimated row height for initial render */
  estimatedRowHeight?: number;
  /** Number of items to render outside the visible area */
  overscan?: number;
  /** Gap between messages in pixels */
  gap?: number;
  /** Additional className for the inner container */
  className?: string;
}

function VirtualizedMessageListInner<T extends UIMessage = UIMessage>({
  messages,
  renderMessage,
  scrollRef,
  onScrollNearTop,
  isLoadingOlder = false,
  estimatedRowHeight = 80,
  overscan = 5,
  gap = 8,
  className = '',
}: VirtualizedMessageListProps<T>) {
  const wasNearTopRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan,
    gap,
  });

  const items = virtualizer.getVirtualItems();

  // Handle scroll to detect when near top
  const handleScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !onScrollNearTop || isLoadingOlder) return;

    const scrollTop = scrollElement.scrollTop;
    const isNearTop = scrollTop < 100;

    if (isNearTop && !wasNearTopRef.current && messages.length > 0) {
      onScrollNearTop();
    }

    wasNearTopRef.current = isNearTop;
  }, [scrollRef, onScrollNearTop, isLoadingOlder, messages.length]);

  // Attach scroll listener
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [scrollRef, handleScroll]);

  // Re-measure when messages change (important for streaming content growth)
  useEffect(() => {
    // Small delay to let content render before measuring
    const timeoutId = setTimeout(() => {
      virtualizer.measure();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [messages, virtualizer]);

  // Empty state - just return null and let parent handle
  if (messages.length === 0) {
    return null;
  }

  return (
    <div
      className={`relative w-full ${className}`}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        contain: 'strict',
      }}
    >
      {items.map((virtualRow: VirtualItem) => {
        const message = messages[virtualRow.index];
        if (!message) return null;

        return (
          <div
            key={message.id || virtualRow.index}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderMessage(message, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}

// Memo wrapper with generic type support
export const VirtualizedMessageList = memo(VirtualizedMessageListInner) as typeof VirtualizedMessageListInner;
