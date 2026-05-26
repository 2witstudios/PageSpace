import React, { useRef, useCallback, useEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual';
import { UIMessage } from 'ai';

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
    }));

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
