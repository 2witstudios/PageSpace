import React, { useRef, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual';
import { UIMessage } from 'ai';
import { computeScrollAnchorAdjustment } from '@/lib/ai/streams/computeScrollAnchorAdjustment';

export interface VirtualizedMessageListRef {
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
}

export interface VirtualizedMessageListProps<T extends UIMessage = UIMessage> {
  messages: T[];
  renderMessage: (message: T, index: number) => React.ReactNode;
  scrollRef: React.RefObject<HTMLElement | null>;
  onScrollNearTop?: () => void;
  isLoadingOlder?: boolean;
  estimatedRowHeight?: number;
  overscan?: number;
  gap?: number;
  className?: string;
}

const VirtualizedMessageListInner = forwardRef<VirtualizedMessageListRef, VirtualizedMessageListProps>(
  (
    {
      messages,
      renderMessage,
      scrollRef,
      onScrollNearTop,
      isLoadingOlder = false,
      estimatedRowHeight = 80,
      overscan = 5,
      gap = 8,
      className = '',
    },
    ref
  ) => {
    const wasNearTopRef = useRef(false);
    // Scroll-anchor bookkeeping for "load older" (epic leaf 6.6, M11): a prepend must not
    // visibly jump the viewport. See computeScrollAnchorAdjustment for the decision.
    const prevMessageIdsRef = useRef<string[]>(messages.map((m) => m.id));
    const prevScrollHeightRef = useRef(0);

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => estimatedRowHeight,
      overscan,
      gap,
    });

    useImperativeHandle(ref, () => ({
      scrollToIndex: (index, options) => {
        virtualizer.scrollToIndex(index, options);
      },
    }), [virtualizer]);

    const items = virtualizer.getVirtualItems();

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

    useEffect(() => {
      const element = scrollRef.current;
      if (!element) return;

      element.addEventListener('scroll', handleScroll, { passive: true });
      return () => element.removeEventListener('scroll', handleScroll);
    }, [scrollRef, handleScroll]);

    // Runs synchronously after the DOM reflects the new `messages` but before the browser
    // paints — a scrollTop write here is invisible to the user, unlike one from a normal
    // effect (which would paint the jump first, then correct it a frame later).
    useLayoutEffect(() => {
      const scrollElement = scrollRef.current;
      if (scrollElement) {
        const nextMessageIds = messages.map((m) => m.id);
        const adjustment = computeScrollAnchorAdjustment({
          prevMessageIds: prevMessageIdsRef.current,
          nextMessageIds,
          prevScrollHeight: prevScrollHeightRef.current,
          nextScrollHeight: scrollElement.scrollHeight,
        });
        if (adjustment > 0) {
          scrollElement.scrollTop += adjustment;
        }
        prevMessageIdsRef.current = nextMessageIds;
        prevScrollHeightRef.current = scrollElement.scrollHeight;
      }
    }, [messages, scrollRef]);

    useEffect(() => {
      const rafId = requestAnimationFrame(() => {
        virtualizer.measure();
      });
      return () => cancelAnimationFrame(rafId);
    }, [messages, virtualizer]);

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
);

VirtualizedMessageListInner.displayName = 'VirtualizedMessageList';

export const VirtualizedMessageList = memo(VirtualizedMessageListInner);
