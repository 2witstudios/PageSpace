'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * The width of the element the returned ref lands on, kept current by a ResizeObserver; null
 * before it is measured and where there is no ResizeObserver (the server, jsdom).
 */
export function useRowWidth(): { readonly ref: (element: HTMLDivElement | null) => void; readonly width: number | null } {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width));
    });
    observer.current.observe(element);
  }, []);
  return { ref, width };
}
