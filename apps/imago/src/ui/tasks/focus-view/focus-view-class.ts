/* The Focus view is one quiet column of groups (myimago focus-view.render.tsx). */
export const focusViewClass = 'flex w-full flex-col gap-4';

export const focusGroupClass = 'flex flex-col gap-1';

/* A group is headed by where its rows live, in the rail's faint small type. */
export const focusHeadingClass = 'flex items-center gap-2 truncate px-2 pt-2 text-2xs font-semibold text-ink-faint';

/** How many tasks "Done today" holds, beside its heading. */
export const focusCountClass = 'font-medium text-ink-muted';

/** What an empty frontier, or an empty day, says. */
export const focusEmptyClass = 'px-2 text-sm text-ink-faint';
