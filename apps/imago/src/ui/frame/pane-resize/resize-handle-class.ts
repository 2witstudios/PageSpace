/**
 * The seam between two columns takes no room of its own, so the hairlines stay where they are;
 * its hit area straddles the seam, under the scrims and sheets.
 */
export const resizeSeamClass = 'relative z-resize w-0 flex-none';

export const resizeHitClass =
  'group absolute inset-y-0 -left-resize-half flex w-resize-hit cursor-col-resize justify-center outline-none';

/** The line shows on hover, on keyboard focus and while dragging, as in classic's handle. */
export const resizeLineClass =
  'h-full w-px bg-accent opacity-0 transition-opacity duration-120 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-active:opacity-100';
