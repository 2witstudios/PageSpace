import { cn } from '../../cn';

/* A task opened as the object: the reading column, as a document sits. */
export const taskDetailClass = 'mx-auto flex w-full max-w-doc flex-col gap-4 px-8 py-6';

export const taskDetailCrumbsClass = 'flex min-w-0 items-center gap-1 text-sm text-ink-muted';

export const taskDetailTitleRowClass = 'flex items-center gap-3';

/* The title is the page's one bold line, edited where it sits. */
export const taskDetailTitleClass =
  'min-w-0 flex-1 bg-transparent text-doc-title leading-tight font-bold tracking-doc-title text-ink outline-none';

/** Why an edit was refused, under the title. */
export const taskDetailNoticeClass = 'text-xs font-medium text-live';

/* PageSpace's fields in one quiet row that wraps. */
export const taskFieldsClass = 'flex flex-wrap gap-x-6 gap-y-3 border-b border-hairline pb-4';

export const taskFieldClass = 'flex flex-col gap-1';

export const taskFieldLabelClass = 'text-2xs text-ink-faint';

export const taskFieldValueClass = 'flex items-center gap-2';

/* One control shape for every field: a hairline that firms on hover, the
   small radius, 13px ink. */
export const taskControlClass =
  'rounded-md border border-hairline bg-transparent px-2 py-1 text-sm text-ink transition-colors duration-120 ease-standard hover:border-border-strong';

export const taskClearClass = 'cursor-pointer text-2xs text-ink-faint hover:text-ink';

export const taskAssigneesClass = 'relative';

export const taskAssigneesSummaryClass = cn(taskControlClass, 'summary-plain flex cursor-pointer items-center gap-2');

export const taskUnassignedClass = 'text-ink-faint';

export const taskAssigneesMenuClass =
  'absolute z-popover mt-1 flex w-popover flex-col gap-1 rounded-lg border border-hairline bg-background p-2 shadow-ambient';

export const taskAssigneesGroupClass = 'px-1 text-2xs font-semibold text-ink-faint';

export const taskAssigneeOptionClass = 'flex items-center gap-2 p-1 text-sm text-ink';

export const taskSectionClass = 'flex flex-col gap-2';

export const taskSectionHeadingClass = 'text-xs font-semibold text-ink-faint';

/* The description editor: prose at the UI size, wrapping as typed. */
export const taskDescriptionClass =
  'min-h-description w-full rounded-md text-sm leading-normal whitespace-pre-wrap text-ink outline-none';

export const taskDetailMessageClass = 'px-6 py-4 text-sm text-ink-muted';

/* The 44px strip's own buttons: a quiet square that firms on hover, dimmed when there is no task that way. */
export const taskStripButtonClass =
  'flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted';

/** "Saved" or a refusal, at the strip's right edge. */
export const taskSavedClass = 'flex items-center gap-2 px-2 text-xs text-ink-muted';

/** The task's own name in the path: the last step, which is not a link. */
export const taskCrumbCurrentClass = 'min-w-0 truncate font-semibold text-ink';

/* The Automations box: one hairline frame, a row per trigger. */
export const taskAutomationsClass = 'flex flex-col rounded-xl border border-hairline';

export const taskAutomationRowClass = 'flex items-center gap-3 px-3 py-2 text-sm text-ink-muted border-t border-hairline first:border-t-0';

export const taskAutomationTextClass = 'min-w-0 flex-1 cursor-pointer truncate text-left text-sm text-ink hover:underline';

export const taskAutomationWhenClass = 'flex-none text-xs text-ink-faint';

/** The Enabled switch: shown, not yet a control (the API has no re-enable). */
export const taskSwitchClass = 'relative inline-flex h-5 w-10 flex-none items-center rounded-full bg-border-strong aria-checked:bg-accent-deep';

export const taskSwitchKnobClass = 'absolute right-1 top-1 size-4 rounded-full bg-background transition-transform duration-120 ease-standard';

export const taskActivityListClass = 'flex flex-col gap-2 text-sm text-ink-muted';

export const taskActivityRowClass = 'flex min-w-0 items-center gap-2';

export const taskActivityTextClass = 'min-w-0 flex-1 truncate';

export const taskActivityTimeClass = 'flex-none text-xs text-ink-faint';
