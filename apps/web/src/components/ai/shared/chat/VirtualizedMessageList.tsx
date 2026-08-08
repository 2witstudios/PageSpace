import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, memo } from 'react';
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual';
import { UIMessage } from 'ai';
import { computeScrollAnchorAdjustment } from '@/lib/ai/streams/computeScrollAnchorAdjustment';

/**
 * How long the pane width must hold still before every cached row height is
 * invalidated. While a resize handle is being dragged the mounted rows are
 * already self-correcting through their own ResizeObserver, so the wipe only
 * needs to land once the drag settles.
 */
const WIDTH_SETTLE_MS = 150;

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

    // The scroll element is an ancestor owned by StickToBottom and can still be null
    // on our first render (see useConversationScrollRef), so mirror it into state to
    // get an effect re-run at the moment it appears.
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(scrollRef.current);
    // Intentionally no dependency array. `scrollRef.current` is populated by an
    // ancestor and is not reactive, so the only reliable moment to notice it is after
    // every render. Taking the rule's suggestion of [scrollRef, scrollElement] would
    // skip precisely the render where the element first appears: the ref object's
    // identity never changes, and scrollElement is still null at that point. The
    // setState is guarded by an inequality check, so it cannot loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (scrollRef.current !== scrollElement) setScrollElement(scrollRef.current);
    });

    // A width change reflows every message, so every cached row height goes stale —
    // including those of rows that are currently unmounted and therefore have no
    // ResizeObserver of their own to report the reflow. Invalidating the whole size
    // cache is exactly right here, and exactly wrong on a `messages` change (see the
    // note below): the width is what determines the heights.
    //
    // `measure()` alone would not be enough. The rows that are still mounted never
    // re-measure after it — their DOM size does not change a second time, so no
    // ResizeObserver fires, and React will not re-invoke a stable function ref on an
    // element that never unmounted — which would leave the visible window pinned at
    // `estimateSize`. Bumping `widthEpoch` into each row's key remounts just that
    // window (a handful of rows), so `measureElement` runs fresh for it.
    const [widthEpoch, setWidthEpoch] = useState(0);

    useEffect(() => {
      if (!scrollElement || typeof ResizeObserver === 'undefined') return;

      let lastWidth = scrollElement.clientWidth;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;

      const observer = new ResizeObserver(() => {
        const width = scrollElement.clientWidth;
        // 0 means the pane is collapsed or hidden: nothing has reflowed to a usable
        // width yet, and measuring against it would cache garbage heights.
        if (width === 0 || width === lastWidth) return;
        lastWidth = width;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          virtualizer.measure();
          setWidthEpoch((epoch) => epoch + 1);
        }, WIDTH_SETTLE_MS);
      });

      observer.observe(scrollElement);
      return () => {
        clearTimeout(settleTimer);
        observer.disconnect();
      };
    }, [scrollElement, virtualizer]);

    // NOTE: do NOT add a `virtualizer.measure()` effect here. `measure()` clears the
    // entire itemSizeCache (virtual-core 3.15.0), so every row falls back to
    // `estimateSize` and `getTotalSize()` collapses. Because this container is
    // `contain: strict` with height = getTotalSize(), the scroller's scrollHeight IS
    // that value, so the browser clamps scrollTop upward by the full delta and the
    // viewport lands near the top — then use-stick-to-bottom animates the long way
    // back down. Since `messages` gets a new array identity on every stream part,
    // that fired on every tool call: the "chat jumps to the top" bug.
    // Per-row growth during streaming is already handled incrementally and correctly
    // by the `ref={virtualizer.measureElement}` ResizeObserver below, which updates
    // just the row that changed and compensates scrollTop for above-viewport resizes.

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
              // can never disagree. The widthEpoch suffix is what forces the
              // mounted window to re-measure after a pane resize — see above.
              key={`${virtualRow.key}:${widthEpoch}`}
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
