import { useCallback, useRef, useState } from 'react';
import type { SheetData } from '@pagespace/lib/client-safe';

const MAX_HISTORY_SIZE = 50;

interface HistoryState {
  past: SheetData[];
  present: SheetData;
  future: SheetData[];
}

interface UseSheetHistoryReturn {
  /** Current sheet state */
  sheet: SheetData;
  /** Update sheet with history tracking */
  setSheet: (updater: SheetData | ((prev: SheetData) => SheetData)) => void;
  /** Undo the last change */
  undo: () => SheetData | null;
  /** Redo a previously undone change */
  redo: () => SheetData | null;
  /** Check if undo is available */
  canUndo: boolean;
  /** Check if redo is available */
  canRedo: boolean;
  /** Reset history with a new initial state */
  reset: (initial: SheetData) => void;
  /** Get current history depth for debugging */
  historyDepth: { past: number; future: number };
}

/**
 * Custom hook for managing sheet history with undo/redo support.
 * Uses an immutable approach to track past/present/future states.
 */
export function useSheetHistory(initialSheet: SheetData): UseSheetHistoryReturn {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: initialSheet,
    future: [],
  });

  // Keep a ref to current history for synchronous reads in undo/redo
  const historyRef = useRef(history);
  historyRef.current = history;

  // Track whether we're in the middle of an undo/redo operation
  const isUndoRedoRef = useRef(false);

  const setSheet = useCallback(
    (updater: SheetData | ((prev: SheetData) => SheetData)) => {
      setHistory((prev) => {
        const newPresent = typeof updater === 'function' ? updater(prev.present) : updater;

        // If the sheet hasn't actually changed, don't add to history
        if (
          JSON.stringify(newPresent.cells) === JSON.stringify(prev.present.cells) &&
          newPresent.rowCount === prev.present.rowCount &&
          newPresent.columnCount === prev.present.columnCount
        ) {
          return prev;
        }

        // If this is an undo/redo operation, don't modify history
        if (isUndoRedoRef.current) {
          return { ...prev, present: newPresent };
        }

        // Add current state to past, clear future, limit history size
        const newPast = [...prev.past, prev.present].slice(-MAX_HISTORY_SIZE);

        return {
          past: newPast,
          present: newPresent,
          future: [], // Clear future on new changes
        };
      });
    },
    []
  );

  const undo = useCallback((): SheetData | null => {
    const current = historyRef.current;

    if (current.past.length === 0) {
      return null;
    }

    const newPast = current.past.slice(0, -1);
    const newPresent = current.past[current.past.length - 1];
    const newFuture = [current.present, ...current.future].slice(0, MAX_HISTORY_SIZE);

    const newHistory: HistoryState = {
      past: newPast,
      present: newPresent,
      future: newFuture,
    };

    setHistory(newHistory);
    return newPresent;
  }, []);

  const redo = useCallback((): SheetData | null => {
    const current = historyRef.current;

    if (current.future.length === 0) {
      return null;
    }

    const newPresent = current.future[0];
    const newFuture = current.future.slice(1);
    const newPast = [...current.past, current.present].slice(-MAX_HISTORY_SIZE);

    const newHistory: HistoryState = {
      past: newPast,
      present: newPresent,
      future: newFuture,
    };

    setHistory(newHistory);
    return newPresent;
  }, []);

  const reset = useCallback((initial: SheetData) => {
    setHistory({
      past: [],
      present: initial,
      future: [],
    });
  }, []);

  return {
    sheet: history.present,
    setSheet,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    reset,
    historyDepth: {
      past: history.past.length,
      future: history.future.length,
    },
  };
}
