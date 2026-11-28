import { cn } from '../../cn';
import type { LastRunTone } from '../../../retained/components/workflows/workflow-view-model';

/* A workflow row (the sidebar row of tasks-pane-class.ts): two lines, the name and its last-run
   badge, then the kind and trigger. The selected row takes the soft accent tint. */
export const workflowRowClass = (selected: boolean): string =>
  cn(
    'flex w-full cursor-pointer flex-col gap-1 rounded-lg px-2 py-2 text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline',
    selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink',
  );

export const workflowRowHeadClass = 'flex min-w-0 items-center gap-2';

export const workflowRowNameClass = 'min-w-0 flex-1 truncate font-medium';

const toneClasses: Readonly<Record<LastRunTone, string>> = {
  success: 'text-status-success',
  danger: 'text-status-danger',
  running: 'text-accent-deep',
  neutral: 'text-ink-faint',
};

/** The last-run badge's text colour. */
export const lastRunBadgeClass = (tone: LastRunTone): string => cn('flex-none text-2xs font-medium', toneClasses[tone]);

export const workflowRowMetaClass = 'truncate text-2xs text-ink-faint';

/** The pane's New button: the primary fill the Button primitive uses, as tasks-pane-class's New list. */
export const newWorkflowClass =
  'flex h-8 items-center justify-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink transition-colors duration-120 ease-standard hover:bg-accent-strong';

export const workflowsPaneMessageClass = 'px-2 text-sm text-ink-muted';
