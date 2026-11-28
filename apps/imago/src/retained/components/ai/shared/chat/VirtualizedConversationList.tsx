/**
 * VirtualizedConversationList - High-performance virtualized conversation list
 *
 * Uses @tanstack/react-virtual for windowed rendering of conversation items.
 *
 * Features:
 * - Fixed height rows for consistent rendering
 * - Smooth scrolling with overscan
 * - Works with both compact and full conversation renderers
 */

import React, { useRef, useCallback, useEffect, memo } from 'react';
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual';

export interface VirtualizedConversationListProps<T> {
  /** Conversations to render */
  conversations: T[];
  /** Render function for each conversation */
  renderConversation: (conversation: T, index: number) => React.ReactNode;
  /** Get unique key for each conversation */
  getKey: (conversation: T) => string;
  /** Optional callback when scrolled near bottom (for loading more) */
  onScrollNearBottom?: () => void;
  /** Whether more conversations are currently loading */
  isLoadingMore?: boolean;
  /** Estimated row height for initial render */
  estimatedRowHeight?: number;
  /** Number of items to render outside the visible area */
  overscan?: number;
  /** Gap between items in pixels */
  gap?: number;
  /** Additional className for the container */
  className?: string;
}

function VirtualizedConversationListInner<T>({
  conversations,
  renderConversation,
  getKey,
  onScrollNearBottom,
  isLoadingMore = false,
  estimatedRowHeight = 60,
  overscan = 5,
  gap = 0,
  className = '',
}: VirtualizedConversationListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan,
    gap,
  });

  const items = virtualizer.getVirtualItems();

  // Handle scroll to detect when near bottom
  const handleScroll = useCallback(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement || !onScrollNearBottom || isLoadingMore) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollElement;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isNearBottom = distanceFromBottom < 100;

    if (isNearBottom && !wasNearBottomRef.current && conversations.length > 0) {
      onScrollNearBottom();
    }

    wasNearBottomRef.current = isNearBottom;
  }, [onScrollNearBottom, isLoadingMore, conversations.length]);

  // Attach scroll listener
  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;

    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Empty state - just return null and let parent handle
  if (conversations.length === 0) {
    return null;
  }

  return (
    <div
      ref={parentRef}
      className={`overflow-y-auto h-full ${className}`}
      style={{ contain: 'strict' }}
    >
      <div
        className="relative w-full"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
        }}
      >
        {items.map((virtualRow: VirtualItem) => {
          const conversation = conversations[virtualRow.index];
          if (!conversation) return null;

          return (
            <div
              key={getKey(conversation)}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderConversation(conversation, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Memo wrapper with generic type support
export const VirtualizedConversationList = memo(VirtualizedConversationListInner) as typeof VirtualizedConversationListInner;
