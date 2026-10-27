/** The gap between a tile's right edge and its tooltip. */
const TOOLTIP_GAP = 8;

/**
 * Places each spine tile's tooltip beside the tile when the pointer enters it or it takes focus.
 * The tooltip is `fixed` (rail-button-class.ts), so its top and left are in viewport pixels and
 * the spine's scroll box cannot clip it. The CSS still decides whether it shows; this only moves it.
 *
 * The tile is tracked only while the pointer or focus is on it, so scrolling the rest of the app
 * costs nothing. A resize or a scroll of the spine moves the tracked tooltip with its tile.
 *
 * Returns a function that removes the listeners.
 */
export const attachRailTooltips = (root: Document = document): (() => void) => {
  let tracked: Element | null = null;

  const onEnter = (event: Event) => {
    const tile = event.target instanceof Element ? event.target.closest('.group') : null;
    if (tile === null || tooltipOf(tile) === null) return;
    tracked = tile;
    place(tile);
  };

  const onLeave = (event: FocusEvent | PointerEvent) => {
    if (tracked === null || !(event.target instanceof Node) || !tracked.contains(event.target)) return;
    const next = event.relatedTarget;
    if (next instanceof Node && tracked.contains(next)) return;
    if (tracked.contains(root.activeElement)) return;
    tracked = null;
  };

  const onMove = () => {
    if (tracked !== null) place(tracked);
  };

  root.addEventListener('pointerover', onEnter);
  root.addEventListener('focusin', onEnter);
  root.addEventListener('pointerout', onLeave);
  root.addEventListener('focusout', onLeave);
  root.addEventListener('scroll', onMove, true);
  root.defaultView?.addEventListener('resize', onMove);

  return () => {
    root.removeEventListener('pointerover', onEnter);
    root.removeEventListener('focusin', onEnter);
    root.removeEventListener('pointerout', onLeave);
    root.removeEventListener('focusout', onLeave);
    root.removeEventListener('scroll', onMove, true);
    root.defaultView?.removeEventListener('resize', onMove);
  };
};

const tooltipOf = (tile: Element): HTMLElement | null =>
  tile.querySelector<HTMLElement>(':scope > [data-rail-tooltip]');

const place = (tile: Element): void => {
  const tip = tooltipOf(tile);
  if (tip === null) return;
  const rect = tile.getBoundingClientRect();
  tip.style.top = `${rect.top + rect.height / 2}px`;
  tip.style.left = `${rect.right + TOOLTIP_GAP}px`;
};
