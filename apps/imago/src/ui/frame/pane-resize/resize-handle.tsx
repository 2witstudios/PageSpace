'use client';

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  BOUNDS,
  clampWidth,
  maxWidthFor,
  widthFromDrag,
  widthFromKey,
  type ResizableColumn,
} from './pane-sizes';
import { resizeHitClass, resizeLineClass, resizeSeamClass } from './resize-handle-class';

export type ResizeHandleProps = {
  readonly column: ResizableColumn;
  /** The column's width as React draws it: the stored width, else the token's. */
  readonly width: number;
  /** Void action: the drag or key settled on a width; null puts the token width back. */
  readonly onResize: (width: number | null) => void;
};

const labels: Readonly<Record<ResizableColumn, string>> = { left: 'Resize sidebar', imago: 'Resize Imago' };

type Drag = { readonly pointerId: number; readonly startX: number; readonly start: number; readonly max: number; width: number };

const asElement = (node: Element | null): HTMLElement | null => (node instanceof HTMLElement ? node : null);

/** The column the seam resizes: the pane before it for the left pane, after it for Imago. */
const paneOf = (seam: HTMLElement, column: ResizableColumn): HTMLElement | null =>
  asElement(column === 'left' ? seam.previousElementSibling : seam.nextElementSibling);

/** What the middle holds now: every growing column in the row (the page, Imago on the ground, the empty middle). */
const middleWidth = (seam: HTMLElement): number => {
  const row = seam.parentElement;
  if (row === null) return 0;
  let width = 0;
  for (const child of Array.from(row.children)) {
    if (child instanceof HTMLElement && getComputedStyle(child).flexGrow !== '0') width += child.getBoundingClientRect().width;
  }
  return width;
};

const measure = (seam: HTMLElement, column: ResizableColumn) => {
  const pane = paneOf(seam, column);
  const current = pane?.getBoundingClientRect().width ?? 0;
  return { pane, current, max: maxWidthFor(column, current, middleWidth(seam)) };
};

/**
 * The drag handle on a docked column's inner edge (classic's ResizableHandle). A drag sets the
 * pane's width straight on its element, with its width transition held off, so the frame does
 * not re-render on every move; the width reaches React once, when the pointer lifts. Arrow keys
 * step it and double-click puts the token width back.
 */
export function ResizeHandle({ column, width, onResize }: ResizeHandleProps): ReactNode {
  const seamRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);

  const end = (target: HTMLElement) => {
    const active = drag.current;
    if (active === null) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    delete target.dataset.active;
    document.body.classList.remove('select-none');
    const seam = seamRef.current;
    const pane = seam === null ? null : paneOf(seam, column);
    if (pane !== null) {
      // A move still waiting on its frame is dropped above, so the pane takes the last width now.
      pane.style.width = `${active.width}px`;
      delete pane.dataset.resizing;
    }
    onResize(active.width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const seam = seamRef.current;
    if (event.button !== 0 || seam === null) return;
    const { pane, current, max } = measure(seam, column);
    if (pane === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.active = '';
    pane.dataset.resizing = '';
    document.body.classList.add('select-none');
    drag.current = { pointerId: event.pointerId, startX: event.clientX, start: current, max, width: current };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    const seam = seamRef.current;
    if (active === null || seam === null || event.pointerId !== active.pointerId) return;
    active.width = clampWidth(column, widthFromDrag(column, active.start, event.clientX - active.startX), active.max);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const pane = paneOf(seam, column);
      const settled = drag.current;
      if (pane !== null && settled !== null) pane.style.width = `${settled.width}px`;
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) end(event.currentTarget);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const seam = seamRef.current;
    if (seam === null) return;
    const { current, max } = measure(seam, column);
    const next = widthFromKey(column, event.key, event.shiftKey, current, max);
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
        aria-valuemax={BOUNDS[column].max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        className={resizeHitClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={(event) => end(event.currentTarget)}
        onDoubleClick={() => onResize(null)}
        onKeyDown={onKeyDown}
      >
        <div className={resizeLineClass} />
      </div>
    </div>
  );
}
