import { buildStatusConfig, getStatusOrder, isCompletedStatus, type TaskStatusConfig } from './task-list-types';

/** One status group of a task list: the board's "To do 4", "Done 4" headers. */
export interface TaskStatusGroup<T extends { readonly status: string }> {
  /** The status slug every task in the group shares. */
  readonly key: string;
  readonly label: string;
  /** Done groups start collapsed; the rest start open. */
  readonly isDone: boolean;
  readonly tasks: readonly T[];
}

/**
 * Pure: buckets tasks by status in the list's own status order, keeping each bucket's
 * incoming order. Empty statuses are left out. A status the list does not define (a stale
 * slug) still gets a group, after the defined ones, so no task is hidden.
 */
export function groupTasksByStatus<T extends { readonly status: string }>(
  tasks: readonly T[],
  statusConfigs: readonly TaskStatusConfig[],
): TaskStatusGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const task of tasks) {
    const bucket = buckets.get(task.status);
    if (bucket) bucket.push(task);
    else buckets.set(task.status, [task]);
  }

  const configs = [...statusConfigs];
  const labels = buildStatusConfig(configs);
  const order = getStatusOrder(configs);
  const keys = [
    ...order.filter((slug) => buckets.has(slug)),
    ...[...buckets.keys()].filter((slug) => !order.includes(slug)),
  ];

  return keys.map((key) => ({
    key,
    label: labels[key]?.label ?? key,
    isDone: isCompletedStatus(key, configs),
    tasks: buckets.get(key) ?? [],
  }));
}
