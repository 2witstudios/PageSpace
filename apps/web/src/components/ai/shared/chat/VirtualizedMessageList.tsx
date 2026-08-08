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

    // Identity-based item keys. Without this, virtual-core defaults to
    // `getItemKey = (index) => index`, so its itemSizeCache maps POSITION -> height:
    // a "load older" prepend silently reassigns every measured height to the wrong
    // message, and switching conversations carries the previous thread's heights
    // over (the virtualizer instance is never remounted). Keying by message id makes
    // the cache content-addressed, which is what makes measuring incrementally —
    // rather than wiping the cache wholesale — correct.
    // `||` rather than `??` so a blank id degrades to the index instead of
    // collapsing every such row onto one cache entry — matching what the row's
    // React key did before.
    const getItemKey = useCallback(
      (index: number) => messages[index]?.id || index,
      [messages]
    );

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => estimatedRowHeight,
      getItemKey,
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

    // NOTE: nothing in this component may call `virtualizer.measure()` — not on a
    // `messages` change, and not on a pane resize either.
    //
    // `measure()` clears the entire itemSizeCache (virtual-core 3.15.0), so every row
    // falls back to `estimateSize` and `getTotalSize()` collapses. Because this
    // container is `contain: strict` with height = getTotalSize(), the scroller's
    // scrollHeight IS that value, so the browser clamps scrollTop upward by the full
    // delta and the viewport lands near the top — then use-stick-to-bottom animates
    // the long way back down. `messages` gets a new array identity on every stream
    // part, so doing it there fired on every tool call: the "chat jumps to the top"
    // bug this component exists to not have.
    //
    // A pane resize (the chat sits inside Layout.tsx's ResizablePanelGroup) is the
    // one case where wiping looks justified, since a width change reflows rows that
    // are unmounted and so have no observer of their own to report it. It isn't:
    //   - Mounted rows already re-measure themselves. virtual-core observes each one
    //     via `ref={virtualizer.measureElement}` and calls resizeItem when it
    //     resizes, compensating scrollTop for above-viewport changes.
    //   - For unmounted rows, a stale real height — measured at a slightly different
    //     width — is a far better estimate than the flat estimateSize the wipe would
    //     replace it with. Invalidating makes getTotalSize() *less* accurate, and
    //     collapses it hard enough to reproduce the jump above.
    // So stale heights are left in place and corrected per-row as rows scroll back
    // into view. The cost is a scrollbar that is slightly off until then; the
    // alternative is the bug.

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
              // Same identifier the virtualizer caches this row's height under
              // (see getItemKey above), so React's identity and the size cache's
              // can never disagree.
              key={virtualRow.key}
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
