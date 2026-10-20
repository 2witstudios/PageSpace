/** The gap between a tile's right edge and its tooltip. */
const TOOLTIP_GAP = 8;

/**
 * Places each spine tile's tooltip beside the tile when the pointer enters it or it takes focus.
 * The tooltip is `fixed` (rail-button-class.ts), so its top and left are in viewport pixels and
 * the spine's scroll box cannot clip it. The CSS still decides whether it shows; this only moves it.
 *
 * Returns a function that removes the listeners.
 */
export const attachRailTooltips = (root: Document = document): (() => void) => {
  let lastTile: Element | null = null;

  const placeFor = (target: EventTarget | null) => {
    const tile = target instanceof Element ? target.closest('.group') : null;
    const tip = tile?.querySelector<HTMLElement>(':scope > [data-rail-tooltip]');
    if (tile === null || tile === undefined || tip === null || tip === undefined) return;
    lastTile = tile;
    place(tile, tip);
  };

  const onScroll = () => {
    const tip = lastTile?.querySelector<HTMLElement>(':scope > [data-rail-tooltip]');
    if (lastTile !== null && tip !== null && tip !== undefined) place(lastTile, tip);
  };

  const onEnter = (event: Event) => placeFor(event.target);

  root.addEventListener('pointerover', onEnter);
  root.addEventListener('focusin', onEnter);
  root.addEventListener('scroll', onScroll, true);

  return () => {
    root.removeEventListener('pointerover', onEnter);
    root.removeEventListener('focusin', onEnter);
    root.removeEventListener('scroll', onScroll, true);
  };
};

const place = (tile: Element, tip: HTMLElement): void => {
  const rect = tile.getBoundingClientRect();
  tip.style.top = `${rect.top + rect.height / 2}px`;
  tip.style.left = `${rect.right + TOOLTIP_GAP}px`;
};
