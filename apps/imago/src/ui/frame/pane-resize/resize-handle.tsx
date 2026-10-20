'use client';

import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { BOUNDS, clampWidth, widthFromDrag, widthFromKey, type ResizableColumn } from './pane-sizes';
import { resizeHitClass, resizeLineClass, resizeSeamClass } from './resize-handle-class';

export type ResizeHandleProps = {
  readonly column: ResizableColumn;
  /** The column's width as React draws it: the stored width, else the token's. */
  readonly width: number;
  /** The px width React puts over the pane's token class, if any (the Pane's `size`). */
  readonly size: number | undefined;
  /** The widest the column may be now, so the middle keeps its minimum (dockedColumns). */
  readonly max: number;
  /** Void action: the drag or key settled on a width; null puts the token width back. */
  readonly onResize: (width: number | null) => void;
};

const labels: Readonly<Record<ResizableColumn, string>> = { left: 'Resize sidebar', imago: 'Resize Imago' };

type Drag = {
  readonly pointerId: number;
  readonly startX: number;
  /** Held for the drag: by an unmount's cleanup the seam's ref is already gone. */
  readonly pane: HTMLElement;
  readonly hit: HTMLElement;
  width: number;
};

/** The column the seam resizes: the pane before it for the left pane, after it for Imago. */
const paneOf = (seam: HTMLElement | null, column: ResizableColumn): HTMLElement | null => {
  const pane = seam === null ? null : column === 'left' ? seam.previousElementSibling : seam.nextElementSibling;
  return pane instanceof HTMLElement ? pane : null;
};

/**
 * The drag handle on a docked column's inner edge (classic's ResizableHandle). A drag sets the
 * pane's width straight on its element, with its width transition held off, so the frame does
 * not re-render on every move; the width reaches React once, when the pointer lifts. Arrow keys
 * step it and double-click puts the token width back.
 */
export function ResizeHandle({ column, width, size, max, onResize }: ResizeHandleProps): ReactNode {
  const seamRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  /**
   * Undo everything the drag did to the page, putting back the width React draws (`restore`).
   * The width eases again once React has drawn the result.
   */
  const release = (restore: number | undefined): Drag | null => {
    const active = drag.current;
    if (active === null) return null;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    document.body.classList.remove('select-none');
    delete active.hit.dataset.active;
    active.pane.style.width = restore === undefined ? '' : `${restore}px`;
    requestAnimationFrame(() => delete active.pane.dataset.resizing);
    return active;
  };

  // The seam goes when its column stops docking (collapsed, or a tier crossed), maybe mid-drag;
  // the Pane has then dropped its own width, so none is put back. `release` reads only refs, so
  // the first render's closure serves the unmount.
  useEffect(() => () => void release(undefined), []);

  const end = () => {
    // This render's handlers hold this render's size: what React draws over the pane now.
    const active = release(size);
    // A press that never moved (a click, or half of a double-click) keeps the token width.
    if (active !== null && active.width !== width) onResize(active.width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const pane = paneOf(seamRef.current, column);
    if (event.button !== 0 || drag.current !== null || pane === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.active = '';
    pane.dataset.resizing = '';
    document.body.classList.add('select-none');
    drag.current = { pointerId: event.pointerId, startX: event.clientX, pane, hit: event.currentTarget, width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    active.width = clampWidth(column, widthFromDrag(column, width, event.clientX - active.startX), max);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current !== null) drag.current.pane.style.width = `${drag.current.width}px`;
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) end();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // From React's width, not the element's: the last step may still be easing.
    const next = widthFromKey(column, event.key, event.shiftKey, width, max);
    if (next === null) return;
    event.preventDefault();
    onResize(clampWidth(column, next, max));
  };

  return (
    <div ref={seamRef} className={resizeSeamClass} data-resize={column}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={labels[column]}
        aria-valuemin={BOUNDS[column].min}
        aria-valuemax={max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        className={resizeHitClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={end}
        onDoubleClick={() => onResize(null)}
        onKeyDown={onKeyDown}
      >
        <div className={resizeLineClass} />
      </div>
    </div>
  );
}
