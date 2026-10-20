import { cn } from '../../cn';
import type { Priority, StatusGroup } from '../task-model/task';
import type { DueTone } from '../task-tree/task-tree';

/* A task opened as the object: the reading column, as a document sits. */
export const taskDetailClass = 'mx-auto flex w-full max-w-doc flex-col gap-4 px-8 py-6';

export const taskDetailCrumbsClass = 'flex min-w-0 items-center gap-1 text-sm text-ink-muted';

export const taskDetailTitleRowClass = 'flex items-center gap-3';

/* The title is the page's one bold line, edited where it sits. */
export const taskDetailTitleClass =
  'min-w-0 flex-1 bg-transparent text-doc-title leading-tight font-bold tracking-doc-title text-ink outline-none';

/** Why an edit was refused, under the title. */
export const taskDetailNoticeClass = 'text-xs font-medium text-live';

/* PageSpace's fields as one quiet row of controls that wraps, each opening its own popover. */
export const taskFieldsClass = 'flex flex-wrap items-center gap-2 border-b border-hairline pb-4';

export const taskFieldValueClass = 'flex items-center gap-2';

/* One control shape for every field: a hairline chip that firms on hover
   and while its popover is open, the small radius, 13px ink. */
export const taskChipClass =
  'inline-flex h-8 items-center gap-2 rounded-md border border-hairline bg-transparent px-2 text-sm text-ink transition-colors duration-120 ease-standard hover:border-border-strong hover:bg-surface-overlay aria-expanded:border-border-strong aria-expanded:bg-surface-overlay';

/** A chip with nothing set yet: its label in the faint ink. */
export const taskChipEmptyClass = cn(taskChipClass, 'text-ink-faint');

/** The Due chip, graded as a card grades it: red while overdue, full ink when soon. */
export const taskDueChipClass = (tone: DueTone | null): string =>
  cn(taskChipClass, tone === 'overdue' ? 'font-medium text-live' : tone === 'soon' && 'font-medium');

const statusTone: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-surface-sunken text-ink',
  in_progress: 'bg-accent-soft text-ink',
  done: 'bg-surface-sunken text-ink-muted',
};

/** The status pill: the chip rounded, tinted by its status's group. */
export const taskStatusPillClass = (group: StatusGroup): string =>
  cn(
    'inline-flex h-8 items-center gap-2 rounded-round px-3 text-sm font-medium transition-colors duration-120 ease-standard hover:bg-surface-overlay aria-expanded:bg-surface-overlay',
    statusTone[group],
  );

const dotTone: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-ink-faint',
  in_progress: 'bg-accent',
  done: 'bg-online',
};

/** A status's group as a dot before its name, as the Board's column heads draw it. */
export const taskStatusDotClass = (group: StatusGroup): string => cn('size-live-dot flex-none rounded-round', dotTone[group]);

/** Imago's own mark beside a date it set. */
export const taskHintClass = 'text-2xs text-ink-faint';

export const taskUnassignedClass = 'text-ink-faint';

/** The priority glyph: three bars, shortest first, standing on one line. */
export const taskPriorityClass = 'flex h-3 flex-none items-end gap-px';

/** One bar, `height` px tall; lit bars read red for high, ink otherwise. */
export const taskPriorityBarClass = (lit: boolean, height: 4 | 8 | 12, priority: Priority): string =>
  cn(
    'w-1 rounded-sm',
    height === 4 ? 'h-1' : height === 8 ? 'h-2' : 'h-3',
    lit ? (priority === 'high' ? 'bg-live' : 'bg-ink-muted') : 'bg-hairline',
  );

/* The assignee popover: a filter field, then Members and Agents. */
export const taskAssigneeFilterClass =
  'w-full rounded-md border border-hairline bg-transparent px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-border-strong';

export const taskAssigneeListClass = 'flex max-h-agent-picker flex-col gap-1 overflow-y-auto';

export const taskAssigneeEmptyClass = 'px-2 py-1 text-xs text-ink-faint';

/* The delete confirmation, in its own small popover off the strip. */
export const taskConfirmClass = 'flex flex-col gap-3 p-2 text-sm text-ink';

export const taskConfirmActionsClass = 'flex justify-end gap-2';

export const taskConfirmCancelClass =
  'rounded-md px-3 py-1 text-xs font-medium text-ink-muted transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink';

export const taskConfirmDeleteClass =
  'rounded-md bg-live px-3 py-1 text-xs font-medium text-accent-ink transition-colors duration-120 ease-standard hover:opacity-90';

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
