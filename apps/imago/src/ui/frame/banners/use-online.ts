'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

const getSnapshot = (): boolean => navigator.onLine;
// The server render assumes online, so hydration matches; the browser then reports the truth.
const getServerSnapshot = (): boolean => true;

/** Whether the navigator is online, following the browser's online and offline events. */
export const useOnline = (): boolean => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
