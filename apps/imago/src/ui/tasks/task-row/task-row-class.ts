import { cn } from '../../cn';

/* A task row is a file-tree row (myimago tree-row-class.ts): ~32px, 13px
   type, quiet ink that comes up to full on hover. It holds controls rather
   than being one, so it carries no pointer of its own. */
export const taskRowClass =
  'flex w-full items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm transition-colors duration-120 ease-standard hover:bg-surface-overlay';

/* A caret takes the checkbox's square, so every title starts on one line;
   a leaf keeps the square empty. */
export const taskSlotClass = 'inline-flex size-checkbox flex-none items-center justify-center';

export const taskToggleClass =
  'inline-flex size-checkbox flex-none cursor-pointer items-center justify-center rounded-sm';

/** A parent's disclosure caret, turned while its subtasks show. */
export const taskCaretClass = (expanded: boolean): string =>
  cn(
    'inline-flex text-ink-faint transition-transform duration-120 ease-standard',
    expanded ? 'rotate-90' : 'rotate-0',
  );

/** A done task's title is struck through and faint. */
export const taskTitleClass = (done: boolean): string =>
  cn('min-w-0 flex-1 truncate', done ? 'text-ink-faint line-through' : 'text-ink');

/** One level of the outline: each nests a step in. */
export const taskLevelClass = 'flex flex-col gap-1';

export const taskChildrenClass = 'flex flex-col gap-1 pl-tree-step';

/** Why an edit was refused, under the row it was for. */
export const taskNoticeClass = 'px-2 pt-1 text-2xs font-medium text-live';
