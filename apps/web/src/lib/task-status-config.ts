// Shared task status configuration used by API routes and UI components.
// Lives in @/lib so both layers can import without cross-layer violations.

export type TaskStatusGroup = 'todo' | 'in_progress' | 'done';

export const DEFAULT_STATUS_CONFIG: Record<string, { label: string; color: string; group: TaskStatusGroup }> = {
  pending: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', group: 'todo' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300', group: 'in_progress' },
  completed: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300', group: 'done' },
  blocked: { label: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300', group: 'in_progress' },
};
