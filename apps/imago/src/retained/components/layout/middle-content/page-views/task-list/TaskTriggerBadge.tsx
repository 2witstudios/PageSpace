'use client';

import { Bell } from 'lucide-react';
import { cn } from '@/retained/lib/utils';

/**
 * The agent-trigger badge on a task: a bell and the count of its active triggers.
 * It only opens the trigger dialog. The trigger summary text stays out of the
 * badge until the list response carries one (needs-api).
 *
 * Renders nothing for a task with no active triggers. Callers gate it on
 * `canEdit`, so a viewer is not told triggers exist.
 */
export function TaskTriggerBadge({
  count,
  onOpen,
  className,
}: {
  readonly count: number;
  readonly onOpen: () => void;
  readonly className?: string;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Agent trigger configured — click to edit"
      aria-label="Agent trigger configured — click to edit"
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md border border-amber-300/60 bg-amber-50 px-1.5 text-[11px] font-medium tabular-nums text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300',
        className,
      )}
    >
      <Bell className="h-3 w-3" aria-hidden="true" />
      <span>{count}</span>
    </button>
  );
}
