// How a task's fields read where it is shown rather than edited: its
// priority, whether it is blocked, and its due date. A due date is read by
// the viewer's own calendar day (dueDay), never the UTC day of the stored
// instant, so a card and the task's detail always name the same day.

import { dayLabel } from '../../time/time';
import { dueDay } from '../task-detail/due-date';
import type { Priority, Task } from '../task-model/task';
import { dueTone, type DueTone } from '../task-tree/task-tree';

/** PageSpace's priorities, highest first, under their names. */
export const priorities: readonly { readonly value: Priority; readonly label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export const isPriority = (value: string): value is Priority =>
  priorities.some((priority) => priority.value === value);

/** A priority a task flags: high or low, by name. */
export type PriorityFlag = { readonly level: Exclude<Priority, 'medium'>; readonly label: string };

/** What a task's priority flags; medium is the default and flags nothing. */
export const priorityFlag = ({ priority }: Task): PriorityFlag | null =>
  priority === 'medium' ? null : { level: priority, label: priority === 'high' ? 'High priority' : 'Low priority' };

/** In PageSpace's Blocked status. */
export const isBlocked = (task: Task): boolean => task.status === 'blocked';

/** The viewer's own calendar day, YYYY-MM-DD, for reading due dates against. */
export const localToday = (now: Date): string => dueDay(now.toISOString());

/** `Today`, `Yesterday`, else `Oct 7`, by the viewer's own day; empty for none. */
export const dueLabel = (dueDate: string | null, today: string): string => {
  const day = dueDay(dueDate);
  return day === '' ? '' : dayLabel(day, today);
};

/** How loudly a due date reads, by the viewer's own day; none without a date. */
export const dueToneOf = (dueDate: string | null, today: string, done: boolean): DueTone | null => {
  const day = dueDay(dueDate);
  return day === '' ? null : dueTone(day, today, done);
};
