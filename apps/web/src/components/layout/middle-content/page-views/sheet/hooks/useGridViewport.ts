"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GridViewportState } from '../core/grid-metrics';

const EMPTY_VIEWPORT: GridViewportState = {
  bodyLeft: 0,
  bodyTop: 0,
  bodyWidth: 0,
  bodyHeight: 0,
  scrollLeft: 0,
  scrollTop: 0,
};

/**
 * Measure the grid's scroll container into state.
 *
 * One measurement feeds three things that must never disagree: which cells are
 * virtualized into existence, where the sticky header strips are translated to,
 * and where the floating cell editor is anchored. Deriving them separately is
 * how an editor ends up drifting a few pixels off its cell.
 *
 * Scroll events are coalesced onto an animation frame — a trackpad fires them
 * far faster than React can usefully re-render, and without this the grid does
 * redundant work for frames that are never painted.
 */
export const useGridViewport = (
  scrollRef: React.RefObject<HTMLElement | null>,
): { viewport: GridViewportState; scrollTo: (left: number, top: number) => void } => {
  const [viewport, setViewport] = useState<GridViewportState>(EMPTY_VIEWPORT);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const next: GridViewportState = {
      bodyLeft: rect.left,
      bodyTop: rect.top,
      bodyWidth: element.clientWidth,
      bodyHeight: element.clientHeight,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    };

    // Bail on an unchanged measurement: scroll fires on both axes and a
    // no-op setState here would re-render every visible cell for nothing.
    setViewport((previous) =>
      previous.bodyLeft === next.bodyLeft &&
      previous.bodyTop === next.bodyTop &&
      previous.bodyWidth === next.bodyWidth &&
      previous.bodyHeight === next.bodyHeight &&
      previous.scrollLeft === next.scrollLeft &&
      previous.scrollTop === next.scrollTop
        ? previous
        : next,
    );
  }, [scrollRef]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    measure();

    element.addEventListener('scroll', scheduleMeasure, { passive: true });

    // The body moves in viewport space whenever a pane is dragged or the window
    // resizes, without any scroll event — the editor anchor depends on catching
    // both.
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    window.addEventListener('resize', scheduleMeasure, { passive: true });

    return () => {
      element.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      observer.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [measure, scheduleMeasure, scrollRef]);

  const scrollTo = useCallback(
    (left: number, top: number) => {
      const element = scrollRef.current;
      if (!element) return;
      if (element.scrollLeft !== left) element.scrollLeft = left;
      if (element.scrollTop !== top) element.scrollTop = top;
      // Reflect the new offsets immediately rather than waiting for the scroll
      // event, so a keyboard-driven move and its repaint land in one frame.
      measure();
    },
    [measure, scrollRef],
  );

  return { viewport, scrollTo };
};
