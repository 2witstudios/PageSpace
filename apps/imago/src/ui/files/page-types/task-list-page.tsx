'use client';

import { useAuth } from '@/retained/hooks/useAuth';
import { TaskListView } from '@/ui/tasks/task-list-view/task-list-view';
import type { PageTypeProps } from './shared';

/**
 * A task list in the v3 middle (C-Tasks-Tree): imago's own list view, its
 * List controls strip over Focus, Tree, Board or Roadmap. The page's title
 * is passed through, so a task's own page opened from Files shows its
 * subtasks as a list too.
 */
export function TaskListPage({ page, driveId, pageId }: PageTypeProps) {
  const { user } = useAuth();
  return <TaskListView driveId={driveId} pageId={pageId} viewerId={user?.id ?? ''} title={page.title} />;
}
