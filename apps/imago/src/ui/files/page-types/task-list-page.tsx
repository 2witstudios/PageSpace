'use client';

import dynamic from 'next/dynamic';
import type { PageTypeProps } from './shared';

const TaskListView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/task-list/TaskListView'), { ssr: false });

/** A task list in the v3 middle (C-Files-TaskList): classic's view; its strip lands in IMC-3.8. */
export function TaskListPage({ page }: PageTypeProps) {
  return <TaskListView page={page} />;
}
