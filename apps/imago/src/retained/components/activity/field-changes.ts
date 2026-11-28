import type { ActivityLog } from './types';

export type FieldChange = {
  readonly field: string;
  readonly before: string;
  readonly after: string;
};

const MAX_LENGTH = 120;

/** A recorded value as the row shows it: text as is, anything else as JSON, long values cut. */
const showValue = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
};

/**
 * The before/after of the fields a change touched, from the values the log recorded. A field
 * with no recorded value on either side is left out rather than shown as a guess.
 */
export const fieldChanges = (activity: ActivityLog, limit = 2): FieldChange[] => {
  const before = activity.previousValues ?? {};
  const after = activity.newValues ?? {};
  return (activity.updatedFields ?? [])
    .filter((field) => field in before || field in after)
    .slice(0, limit)
    .map((field) => ({ field, before: showValue(before[field]), after: showValue(after[field]) }));
};
