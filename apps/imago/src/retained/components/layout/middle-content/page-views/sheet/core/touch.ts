/**
 * Pure touch-gesture classification for the sheet view. Every timing decision
 * takes an explicit timestamp so the shell hook can inject a clock and tests
 * stay deterministic — nothing here reads `Date.now()`.
 */

export const MOVE_THRESHOLD = 10; // px of travel before a touch stops being a tap
export const TAP_MAX_DURATION = 300; // ms; longer than this is not a tap
export const DOUBLE_TAP_WINDOW = 300; // ms between taps on the same cell
export const LONG_PRESS_DELAY = 500; // ms held before a long-press fires

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TouchStart extends TouchPoint {
  time: number;
}

export interface TapRecord {
  row: number;
  column: number;
  time: number;
}

/** Whether a touch has travelled far enough to no longer count as a stationary tap. */
export const exceededMoveThreshold = (start: TouchPoint, point: TouchPoint): boolean =>
  Math.abs(point.x - start.x) > MOVE_THRESHOLD || Math.abs(point.y - start.y) > MOVE_THRESHOLD;

/** Whether a completed touch is a tap: short in time and still in space. */
export const isTapGesture = (start: TouchStart, end: TouchPoint, now: number): boolean => {
  const duration = now - start.time;
  return (
    duration < TAP_MAX_DURATION &&
    Math.abs(end.x - start.x) < MOVE_THRESHOLD &&
    Math.abs(end.y - start.y) < MOVE_THRESHOLD
  );
};

/** Whether a tap on a cell continues a prior tap on the same cell within the window. */
export const isDoubleTap = (
  last: TapRecord | null,
  cell: { row: number; column: number },
  now: number,
): boolean =>
  last !== null &&
  last.row === cell.row &&
  last.column === cell.column &&
  now - last.time < DOUBLE_TAP_WINDOW;
