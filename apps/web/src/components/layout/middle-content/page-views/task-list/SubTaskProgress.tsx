'use client';

import { formatSubTaskProgress } from './task-tree-core';
import type { TaskItem } from './task-list-types';

/**
 * "2/5" beside a task that has sub-tasks, on every surface that renders a task.
 *
 * One component because there are three such surfaces — the table row, the
 * kanban card and the narrow-screen card — and they had three copies of this,
 * comment included. The comment is the reason it is worth sharing: getting the
 * accessible half right is not obvious, and three copies of a subtlety is three
 * chances to fix it in one place and not the others.
 *
 * Renders nothing when the task has no sub-tasks.
 */
export function SubTaskProgress({ task, className }: {
  task: Pick<TaskItem, 'subTaskCount' | 'subTaskCompletedCount'>;
  className?: string;
}) {
  const progress = formatSubTaskProgress(task);
  if (!progress) return null;
  return (
    <span
      className={className}
      // `title` stays: it is the sighted tooltip and, unlike aria-label, is not
      // an ARIA naming mechanism, so role=generic does not discard it.
      title={`${progress.label} sub-tasks complete`}
    >
      {/* ARIA forbids naming role=generic, so an aria-label on a plain span is
          discarded and a screen reader hears only "2/3" — which means nothing on
          its own. The sentence goes in sr-only text instead, and the visible
          ratio is hidden from AT so it is not announced twice. */}
      <span aria-hidden="true">{progress.label}</span>
      <span className="sr-only">{`${progress.label} sub-tasks complete`}</span>
    </span>
  );
}
