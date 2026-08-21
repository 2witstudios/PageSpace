/**
 * Pure layout core for the sheet view. All viewport/element geometry is injected
 * so nothing here reads the DOM, `window`, or `navigator`. The shell measures
 * those into state/props and passes them in; these functions only compute
 * positions and the mobile-breakpoint decision.
 */

/** The mobile breakpoint (Tailwind `sm`). */
export const MOBILE_BREAKPOINT = 640;

/**
 * Whether to use the mobile layout: prefer the measured container width, falling
 * back to the viewport width when the container has not been measured yet
 * (e.g. first paint).
 */
export const isMobileWidth = (containerWidth: number | undefined, viewportWidth: number): boolean =>
  (containerWidth ?? viewportWidth) < MOBILE_BREAKPOINT;

export interface EditorCellRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface EditorPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Position the floating cell editor over a cell, lifting it above the on-screen
 * keyboard when the cell would otherwise be occluded.
 */
export const computeEditorPosition = (
  cellRect: EditorCellRect,
  keyboardHeight: number,
  viewport: { height: number },
  isMobile: boolean,
): EditorPosition => {
  const minWidth = isMobile ? 100 : 120;
  const minHeight = isMobile ? 36 : cellRect.height;

  const availableHeight = viewport.height - keyboardHeight;
  const cellBottom = cellRect.top + Math.max(cellRect.height, minHeight);

  let adjustedTop = cellRect.top;
  if (keyboardHeight > 0 && cellBottom > availableHeight - 20) {
    adjustedTop = availableHeight - Math.max(cellRect.height, minHeight) - 20;
    adjustedTop = Math.max(20, adjustedTop);
  }

  return {
    left: cellRect.left,
    top: adjustedTop,
    width: Math.max(cellRect.width, minWidth),
    height: Math.max(cellRect.height, minHeight),
  };
};
