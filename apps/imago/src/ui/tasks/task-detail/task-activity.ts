// What a task's Activity section and its "set by Imago" note read from GET
// /api/activities. Pure: the clock is passed in, so a test can pin it.

import type { ActivityResponse } from '../task-model/task';

export type ActivityRow = {
  readonly id: string;
  /** "Imago" for the AI's own work, else the actor's name. */
  readonly actor: string;
  readonly action: string;
  readonly time: string;
  readonly byImago: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "2m", "3h", "Yesterday", then the day: how long ago an activity happened. */
export const timeAgo = (iso: string, now: Date): string => {
  const at = new Date(iso);
  const elapsed = now.getTime() - at.getTime();
  if (elapsed < 60 * 1000) return 'Just now';
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 1000))}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / (60 * 60 * 1000))}h`;
  if (elapsed < 2 * DAY) return 'Yesterday';
  return dayFormat.format(at);
};

const FIELD_ACTIONS: Readonly<Record<string, string>> = {
  dueDate: 'set due date',
  status: 'moved status',
  priority: 'set priority',
  title: 'renamed',
  assigneeIds: 'changed assignees',
};

/** What an activity did, in the words the board uses: the first field it changed, else its operation. */
export const actionOf = ({ operation, updatedFields }: Pick<ActivityResponse, 'operation' | 'updatedFields'>): string => {
  const field = (updatedFields ?? []).find((name) => name in FIELD_ACTIONS);
  if (field !== undefined) return FIELD_ACTIONS[field] ?? operation;
  if (operation === 'create') return 'created this task';
  if (operation === 'trash') return 'moved to trash';
  if (operation === 'update') return 'edited this task';
  return operation;
};

/** The Activity section's rows, newest first, as the API sent them. */
export const activityRows = (activities: readonly ActivityResponse[], now: Date): readonly ActivityRow[] =>
  activities.map((activity) => {
    const byImago = activity.isAiGenerated;
    return {
      id: activity.id,
      actor: byImago ? 'Imago' : (activity.actorDisplayName ?? activity.user?.name ?? 'Someone'),
      action: actionOf(activity),
      time: timeAgo(activity.timestamp, now),
      byImago,
    };
  });

/** Whether Imago made the latest change to a field: the Due row's "set by Imago". */
export const setByImago = (activities: readonly ActivityResponse[], field: string): boolean => {
  const latest = activities.find((activity) => (activity.updatedFields ?? []).includes(field));
  return latest?.isAiGenerated === true;
};
