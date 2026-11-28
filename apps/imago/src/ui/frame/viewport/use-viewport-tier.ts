'use client';

import { useSyncExternalStore } from 'react';
import { tierFromMatches, tierQueries, type ViewportTier } from './viewport-tier';

const lists = (): readonly MediaQueryList[] | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : tierQueries.map((query) => window.matchMedia(query));

const subscribe = (notify: () => void): (() => void) => {
  const found = lists();
  if (found === null) return () => {};
  found.forEach((list) => list.addEventListener('change', notify));
  return () => found.forEach((list) => list.removeEventListener('change', notify));
};

const snapshot = (): ViewportTier => {
  const found = lists();
  return found === null ? 'desktop' : tierFromMatches(found.map((list) => list.matches));
};

/** The server render and the hydrating pass are always desktop: the width is unknown there. */
const serverSnapshot = (): ViewportTier => 'desktop';

/** The viewer's tier, following the window as it crosses a boundary. */
export const useViewportTier = (): ViewportTier => useSyncExternalStore(subscribe, snapshot, serverSnapshot);

/** Whether the viewport is a phone (under 600px). */
export const usePhone = (): boolean => useViewportTier() === 'phone';
