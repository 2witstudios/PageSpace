import { cn } from '../../cn';

/** A nav row: 32px, 8px radius on hover; the current one primary-soft (SPEC settings panes). 44px on a phone. */
export const navRowClass = (current: boolean): string =>
  cn(
    'flex h-8 items-center rounded-md px-2 text-sm no-underline hover:no-underline phone:h-phone-row phone:text-base',
    current ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

/** A group label: 11px uppercase, .06em. */
export const navGroupLabelClass = 'px-2 pt-2 pb-1 text-2xs font-medium tracking-wide text-ink-muted uppercase';
