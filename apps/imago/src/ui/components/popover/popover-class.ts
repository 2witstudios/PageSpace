import { cn } from '../../cn';

export type PopoverWidth = 'popover' | 'menu' | 'auto';

const widths: Readonly<Record<PopoverWidth, string>> = {
  popover: 'w-popover',
  menu: 'w-menu',
  auto: '',
};

/* The v3 raised glass the rail overflow and the Board's Move to… draw
   (board-view-class boardMenuClass), here portalled to the body, so it is
   positioned by the popper rather than `absolute` under its trigger. */
export const popoverContentClass = (width: PopoverWidth): string =>
  cn(
    'z-popover flex flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised outline-none',
    widths[width],
  );

/* A row in a menu or a popover list: the Board menu's row, lit while the
   pointer or the keyboard is on it. */
export const menuItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink outline-none hover:bg-surface-overlay focus-visible:bg-surface-overlay data-highlighted:bg-surface-overlay disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

/** The check at a chosen row's end. */
export const menuCheckClass = 'ml-auto flex-none text-ink-muted';

/** A group's quiet head inside a menu. */
export const menuLabelClass = 'px-2 pt-1 text-2xs font-semibold text-ink-faint';
