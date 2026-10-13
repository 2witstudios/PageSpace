import { cn } from '../../cn';

/** A spine tile's two sizes: the four primary sections, and the tools, Search, bell and Settings. */
export type SpineTileSize = 'primary' | 'small';

const tileBase =
  'group relative flex flex-none items-center justify-center no-underline transition-colors duration-120 ease-standard hover:no-underline';

/**
 * A spine destination (SPEC v3 spine, C-Files-Doc): 48px radius-12 tiles for Chat, Files,
 * Messages and Tasks, 40px radius-10 tiles for everything else. The active one is filled
 * white at 15% and marked; the rest sit quieter on the blue and fill white at 10% on hover.
 */
export const spineTileClass = (size: SpineTileSize, active: boolean, enabled = true): string =>
  cn(
    tileBase,
    size === 'primary' ? 'size-spine-tile rounded-spine-tile' : 'size-spine-tile-small rounded-lg',
    active
      ? 'bg-spine-active text-spine-on'
      : cn(size === 'primary' ? 'text-spine-quiet' : 'text-spine-dim', enabled ? 'cursor-pointer hover:bg-spine-hover' : 'cursor-default'),
  );

/** The 4px bar at the spine's edge beside the active tile: 24px beside a primary tile, 20px beside a tool. */
export const spineMarkerClass = (size: SpineTileSize): string =>
  cn(
    'absolute top-1/2 w-spine-marker -translate-y-1/2 rounded-r-sm bg-spine-marker',
    size === 'primary' ? '-left-3 h-spine-marker-tall' : '-left-4 h-spine-marker-short',
  );

/** The amber count on Messages and the bell. */
export const spineCountClass =
  'absolute top-1 right-1 flex h-spine-count min-w-spine-count items-center justify-center rounded-round bg-notice px-1 text-badge leading-none font-bold text-notice-ink';

/** The spine's lists: tiles stacked 4px apart, centred on the spine. */
export const spineListClass = 'm-0 flex list-none flex-col items-center gap-rail-gap p-0';

/** The 28px rule between the sections and the tools. */
export const spineDividerClass = 'my-2 h-px w-spine-divider flex-none bg-spine-active';

/** The label beside a hovered or focused tile; the tile carries the name. */
export const railTooltipClass =
  'pointer-events-none invisible absolute top-1/2 left-rail-tooltip-x z-popover -translate-y-1/2 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-2xs whitespace-nowrap text-ink opacity-0 shadow-2 transition-opacity duration-120 ease-standard group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100';
