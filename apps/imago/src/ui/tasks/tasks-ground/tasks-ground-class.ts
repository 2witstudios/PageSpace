import { cn } from '../../cn';
import type { Priority, StatusGroup } from '../task-model/task';
import type { DueTone } from '../task-tree/task-tree';

export const groundClass = 'flex h-full min-h-0 flex-col overflow-y-auto px-8 pt-8 pb-4';

export const groundInnerClass = 'mx-auto w-full max-w-imago-ground';

export const groundHeadingClass = 'm-0 text-2xl font-semibold tracking-tight text-ink';

export const groundSubtitleClass = 'mt-1 text-sm text-ink-muted';

/** The Active · Completed · All segment. */
export const statusGroupClass = 'flex rounded-md bg-surface-sunken p-px';

export const statusOptionClass = (on: boolean): string =>
  cn(
    'h-8 rounded-sm px-3 text-sm transition-colors duration-120 ease-standard',
    on ? 'bg-surface-raised font-medium text-ink shadow-1' : 'text-ink-muted hover:text-ink',
  );

export const sectionClass = 'mt-6';

export const sectionHeadClass = 'flex h-8 items-center gap-2 border-b border-hairline text-sm font-semibold text-ink';

export const sectionCountClass = 'font-normal text-ink-muted';

/** A row and, under it, why its last tick was refused. */
export const rowWrapClass = 'flex flex-col border-b border-hairline';

/** A row; a done one is dimmed. */
export const rowClass = (done: boolean): string =>
  cn(
    'flex min-h-10 items-center gap-3 px-2 transition-colors duration-120 ease-standard hover:bg-surface-overlay',
    done && 'opacity-60',
  );

/** The title; a done one is struck through. */
export const rowTitleClass = (done: boolean): string =>
  cn('block min-w-0 truncate text-sm no-underline hover:underline', done ? 'text-ink-muted line-through' : 'text-ink');

/** Why a tick was refused, under the row, as a list row says it (task-row-class taskNoticeClass). */
export const rowNoticeClass = 'px-2 pb-1 text-2xs font-medium text-live';

export const rowMetaClass = 'block truncate text-xs text-ink-muted';

export const statusPillClass =
  'inline-flex h-6 flex-none items-center gap-1 truncate rounded-full bg-surface-sunken px-2 text-xs text-ink-muted';

export const statusDotClass = (group: StatusGroup): string =>
  cn(
    'size-2 flex-none rounded-full',
    group === 'done' ? 'bg-status-success' : group === 'in_progress' ? 'bg-status-warning' : 'bg-ink-faint',
  );

export const priorityClass = 'flex h-3 w-8 flex-none items-end gap-1';

/** One of a row's three bars, `height` px tall; lit bars take the priority's colour. */
export const priorityBarClass = (lit: boolean, height: 4 | 8 | 12, priority: Priority): string =>
  cn(
    'w-1 rounded-sm',
    height === 4 ? 'h-1' : height === 8 ? 'h-2' : 'h-3',
    lit ? (priority === 'high' ? 'bg-status-warning' : 'bg-ink-faint') : 'bg-hairline',
  );

export const peopleClass = 'flex w-16 flex-none justify-end';

/** A person's round avatar, or an agent's square one, in its tint. */
export const avatarClass = (agent: boolean): string =>
  cn(
    'flex size-6 flex-none items-center justify-center text-2xs font-semibold ring-2 ring-surface-raised',
    agent ? 'rounded-md bg-agent-soft text-type-agent' : 'rounded-full bg-surface-sunken text-ink-muted',
  );

export const avatarOverlapClass = '-ml-1 first:ml-0';

export const dueClass = (tone: DueTone | null): string =>
  cn(
    'w-16 flex-none text-right text-sm',
    tone === 'overdue' ? 'font-medium text-status-danger' : tone === 'soon' ? 'font-medium text-status-warning-ink' : 'text-ink-muted',
  );

export const groundNoticeClass = 'py-6 text-sm text-ink-muted';
