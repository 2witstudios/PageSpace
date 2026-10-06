import { cn } from '../../cn';

/* One row of the file tree, as myimago's tree row draws it: 32px and quiet
   (13px, normal weight, muted ink) so the tree recedes behind the page it
   indexes. Hover brings a row to full ink; the open page takes the soft
   accent tint at full ink. The ink never turns blue. */
const base =
  'flex h-8 w-full items-center gap-1 rounded-lg px-1 text-left text-sm transition-colors duration-120 ease-standard';

/** A tree row, the open page tinted; a row still being created is faded. */
export const treeRowClass = ({ selected, pending }: { readonly selected: boolean; readonly pending: boolean }): string =>
  cn(
    base,
    selected ? 'bg-accent-soft font-normal text-ink' : 'font-normal text-ink-muted hover:bg-surface-overlay hover:text-ink',
    pending && 'opacity-60',
  );

/**
 * The row's name opens the page. It takes the row's ink, so it reads as the
 * row rather than as a link, and fills the row beside the caret.
 */
export const treeLinkClass =
  'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 text-inherit no-underline hover:no-underline';

/** The disclosure control: a 16px target ahead of the icon. */
export const treeToggleClass =
  'inline-flex size-4 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-ink-faint hover:text-ink';

/** Where a row with nothing to disclose keeps its caret's room, so names align. */
export const treeSpacerClass = 'size-4 flex-none';

/** The caret turns down while the page is open. */
export const treeCaretClass = (expanded: boolean): string =>
  cn('inline-flex transition-transform duration-120 ease-standard', expanded ? 'rotate-90' : 'rotate-0');

export const treeNameClass = 'min-w-0 flex-1 truncate';

/** A folder's item count. */
export const treeCountClass = 'flex-none text-2xs text-ink-faint';

/** One level down: a real nested list, stepped in. */
export const treeChildrenClass = 'flex flex-col gap-1 pl-tree-step';
