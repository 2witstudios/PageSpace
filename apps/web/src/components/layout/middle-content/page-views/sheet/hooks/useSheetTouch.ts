import { useCallback, useRef, useState } from 'react';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import { clampSelection, isCellInSelection, type GridSelection, type SelectionState } from '../core/selection';
import {
  exceededMoveThreshold,
  isTapGesture,
  isDoubleTap,
  LONG_PRESS_DELAY,
  type TouchStart,
  type TapRecord,
} from '../core/touch';

/**
 * Shell hook for the sheet's mobile touch gestures. All timing decisions defer
 * to the pure `core/touch` predicates; the clock is injected (defaulting to
 * `Date.now`) so gesture branches are deterministic under test. The long-press,
 * tap and double-tap effects live here; the geometry does not.
 */
export interface UseSheetTouchParams {
  sheet: SheetData;
  selection: SelectionState;
  isReadOnly: boolean;
  onTap: (row: number, column: number) => void;
  onDoubleTap: (row: number, column: number) => void;
  onLongPressSelect: (cell: GridSelection) => void;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** Injected haptic feedback; defaults to navigator.vibrate. */
  vibrate?: (ms: number) => void;
}

export interface MobileActionSheetState {
  show: boolean;
  cell: GridSelection | null;
}

const defaultVibrate = (ms: number) => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(ms);
  }
};

export const useSheetTouch = ({
  sheet,
  selection,
  isReadOnly,
  onTap,
  onDoubleTap,
  onLongPressSelect,
  now = Date.now,
  vibrate = defaultVibrate,
}: UseSheetTouchParams) => {
  const touchStartRef = useRef<TouchStart | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<TapRecord | null>(null);

  const [mobileActionSheet, setMobileActionSheet] = useState<MobileActionSheetState>({
    show: false,
    cell: null,
  });

  const handleCellTouchStart = useCallback(
    (row: number, column: number, event: React.TouchEvent) => {
      const touch = event.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: now() };

      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }

      const cell = clampSelection({ row, column }, sheet);
      longPressTimerRef.current = setTimeout(() => {
        if (!isCellInSelection(row, column, selection)) {
          onLongPressSelect(cell);
        }
        setMobileActionSheet({ show: true, cell });
        vibrate(50);
      }, LONG_PRESS_DELAY);
    },
    [sheet, selection, now, vibrate, onLongPressSelect]
  );

  const handleCellTouchMove = useCallback((event: React.TouchEvent) => {
    if (touchStartRef.current && longPressTimerRef.current) {
      const touch = event.touches[0];
      if (exceededMoveThreshold(touchStartRef.current, { x: touch.clientX, y: touch.clientY })) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  const handleCellTouchEnd = useCallback(
    (row: number, column: number, event: React.TouchEvent) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      const start = touchStartRef.current;
      if (start) {
        const touch = event.changedTouches[0];
        const end = { x: touch.clientX, y: touch.clientY };
        const nowTs = now();

        if (isTapGesture(start, end, nowTs)) {
          event.preventDefault();

          if (isDoubleTap(lastTapRef.current, { row, column }, nowTs)) {
            if (!isReadOnly) {
              onDoubleTap(row, column);
            }
            lastTapRef.current = null;
          } else {
            onTap(row, column);
            lastTapRef.current = { row, column, time: nowTs };
          }
        }
      }

      touchStartRef.current = null;
    },
    [isReadOnly, onTap, onDoubleTap, now]
  );

  const closeMobileActionSheet = useCallback(() => {
    setMobileActionSheet({ show: false, cell: null });
  }, []);

  return {
    mobileActionSheet,
    setMobileActionSheet,
    closeMobileActionSheet,
    handleCellTouchStart,
    handleCellTouchMove,
    handleCellTouchEnd,
  };
};
