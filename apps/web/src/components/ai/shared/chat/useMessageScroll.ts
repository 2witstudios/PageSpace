/**
 * useMessageScroll - Hook for "scroll-to-user-message" chat UX pattern
 *
 * This implements the common chat pattern where:
 * 1. User sends a message → scrolls so user's message is at TOP of viewport
 * 2. AI response streams below it into the empty space
 * 3. During streaming, does NOT auto-scroll (lets content fill viewport)
 * 4. User can manually scroll during streaming to follow content
 *
 * Designed for virtualization compatibility:
 * - Uses pixel-based scrolling (not index-based)
 * - Targets elements by data-message-id attribute
 * - Works with react-window, react-virtualized, or similar
 */

import { useRef, useCallback, useEffect } from 'react';

interface UseMessageScrollOptions {
  /** Ref to the scrollable container element */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Whether the AI is currently streaming a response */
  isStreaming: boolean;
  /** Padding from top of viewport when scrolling to message (default: 16px) */
  topPadding?: number;
  /** Whether to use smooth scrolling (default: false for instant during send) */
  smoothScroll?: boolean;
}

interface UseMessageScrollReturn {
  /**
   * Scroll so a specific message is at the top of the viewport.
   * Used when user sends a message.
   */
  scrollToMessage: (messageId: string) => void;
  /**
   * Traditional scroll to bottom of messages.
   * Can be used for manual "scroll to bottom" buttons.
   */
  scrollToBottom: () => void;
  /**
   * Whether auto-scroll is currently active.
   * False during streaming if user sent a message (waiting for response).
   */
  isAutoScrollActive: boolean;
  /**
   * Call this when user manually scrolls during streaming to re-enable following.
   */
  enableAutoScroll: () => void;
  /**
   * Call this when user sends a message to disable auto-scroll during streaming.
   */
  disableAutoScroll: () => void;
}

export function useMessageScroll({
  scrollContainerRef,
  isStreaming,
  topPadding = 16,
  smoothScroll = false,
}: UseMessageScrollOptions): UseMessageScrollReturn {
  // Track whether we should auto-scroll during streaming
  // When user sends message, we disable this so content fills viewport
  const autoScrollActiveRef = useRef(true);

  // Track if we've just sent a message (to know when to scroll to it)
  const pendingScrollToMessageRef = useRef<string | null>(null);

  /**
   * Scroll so a message element is at the top of the viewport
   */
  const scrollToMessage = useCallback(
    (messageId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;

      // Find the message element by data attribute
      const messageElement = container.querySelector(
        `[data-message-id="${messageId}"]`
      ) as HTMLElement | null;

      if (!messageElement) {
        // Message might not be rendered yet - store for later
        pendingScrollToMessageRef.current = messageId;
        return;
      }

      // Calculate scroll position to put message at top of viewport
      // We want the message's top edge at the top of the container (with padding)
      const containerRect = container.getBoundingClientRect();
      const messageRect = messageElement.getBoundingClientRect();

      // Current scroll position + distance from container top to message top
      const targetScrollTop =
        container.scrollTop + (messageRect.top - containerRect.top) - topPadding;

      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: smoothScroll ? 'smooth' : 'instant',
      });

      // Clear pending scroll since we've handled it
      pendingScrollToMessageRef.current = null;
      // Disable auto-scroll during streaming so response fills empty space
      autoScrollActiveRef.current = false;
    },
    [scrollContainerRef, topPadding, smoothScroll]
  );

  /**
   * Traditional scroll to bottom
   */
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: smoothScroll ? 'smooth' : 'instant',
    });
  }, [scrollContainerRef, smoothScroll]);

  /**
   * Enable auto-scroll (e.g., user scrolled down manually during streaming)
   */
  const enableAutoScroll = useCallback(() => {
    autoScrollActiveRef.current = true;
  }, []);

  /**
   * Disable auto-scroll (e.g., user sent a message, waiting for response)
   */
  const disableAutoScroll = useCallback(() => {
    autoScrollActiveRef.current = false;
  }, []);

  // When streaming ends, re-enable auto-scroll for next interaction
  useEffect(() => {
    if (!isStreaming) {
      autoScrollActiveRef.current = true;
    }
  }, [isStreaming]);

  // Check for pending scroll when DOM updates
  useEffect(() => {
    if (pendingScrollToMessageRef.current) {
      const messageId = pendingScrollToMessageRef.current;
      // Use requestAnimationFrame to wait for DOM to settle
      const frameId = requestAnimationFrame(() => {
        scrollToMessage(messageId);
      });
      return () => cancelAnimationFrame(frameId);
    }
  });

  return {
    scrollToMessage,
    scrollToBottom,
    isAutoScrollActive: autoScrollActiveRef.current,
    enableAutoScroll,
    disableAutoScroll,
  };
}
