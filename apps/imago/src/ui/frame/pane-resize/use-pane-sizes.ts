'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NO_SIZES, PANE_SIZES_KEY, parseSizes, serializeSizes, type PaneSizes, type ResizableColumn } from './pane-sizes';

/** localStorage, which can throw (private windows, blocked site data): sizes then live for the session. */
const storage = {
  read: (): string | null => {
    try {
      return window.localStorage.getItem(PANE_SIZES_KEY);
    } catch {
      return null;
    }
  },
  write: (value: string): void => {
    try {
      window.localStorage.setItem(PANE_SIZES_KEY, value);
    } catch {
      // The widths still hold for this window.
    }
  },
};

export type PaneSizesControl = {
  readonly sizes: PaneSizes;
  /** Void action: keep a column at a width, or back at its token width with null. */
  readonly setSize: (column: ResizableColumn, width: number | null) => void;
};

/**
 * The viewer's column widths. The first render is the token widths, as the server drew them;
 * the stored widths apply once mounted. A drag writes here only when it ends.
 */
export function usePaneSizes(): PaneSizesControl {
  const [sizes, setSizes] = useState<PaneSizes>(NO_SIZES);
  const latest = useRef(sizes);
  useEffect(() => {
    latest.current = parseSizes(storage.read());
    setSizes(latest.current);
  }, []);
  const setSize = useCallback((column: ResizableColumn, width: number | null) => {
    if (latest.current[column] === width) return;
    latest.current = { ...latest.current, [column]: width };
    storage.write(serializeSizes(latest.current));
    setSizes(latest.current);
  }, []);
  return { sizes, setSize };
}
