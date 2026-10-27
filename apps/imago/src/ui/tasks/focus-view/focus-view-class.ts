import { cn } from '../../cn';
import type { DueTone } from '../task-tree/task-tree';

/* The Focus view is one quiet column of groups (myimago focus-view.render.tsx). */
export const focusViewClass = 'flex w-full flex-col gap-4';

export const focusGroupClass = 'flex flex-col gap-1';

/* A group is headed by where its rows live, in the rail's faint small type. */
export const focusHeadingClass = 'flex items-center gap-2 truncate px-2 pt-2 text-2xs font-semibold text-ink-faint';

/** How many tasks "Done today" holds, beside its heading. */
export const focusCountClass = 'font-medium text-ink-muted';

/** What an empty frontier, or an empty day, says. */
export const focusEmptyClass = 'px-2 text-sm text-ink-faint';

const dueChipTones: Readonly<Record<DueTone, string>> = {
  overdue: 'bg-notice text-notice-ink',
  soon: 'bg-accent-soft text-accent-deep',
  later: 'bg-fill text-ink-muted',
};

/** A parent's due date after its group's heading, toned like a row's. */
export const focusDueChipClass = (tone: DueTone): string =>
  cn('flex-none rounded-round px-2 text-2xs font-semibold normal-case', dueChipTones[tone]);

/** "+N more" and "Show fewer", indented to the titles they follow. */
export const focusMoreClass =
  'cursor-pointer self-start rounded-md px-2 py-1 pl-10 text-xs font-medium text-ink-muted hover:text-ink';

/** "Done today" as its own disclosure. */
export const focusToggleClass = 'cursor-pointer rounded-sm hover:text-ink';

/** The scope switch, alone on its row above the groups. */
export const focusScopeClass = 'flex items-center justify-between gap-3';
