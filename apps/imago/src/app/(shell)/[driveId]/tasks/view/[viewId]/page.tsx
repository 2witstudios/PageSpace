import { notFound } from 'next/navigation';
import { getViewer } from '@/lib/auth/get-viewer';
import { isTaskViewId } from '@/ui/tasks/task-views/task-views';
import { TasksGround } from '@/ui/tasks/tasks-ground/tasks-ground';

/** A smart view's tasks in the middle, the Tasks pane beside them. */
export default async function Page({ params }: { readonly params: Promise<{ readonly driveId: string; readonly viewId: string }> }) {
  const [{ driveId, viewId }] = await Promise.all([params, getViewer()]);
  if (!isTaskViewId(viewId)) notFound();
  return <TasksGround driveId={driveId} view={viewId} />;
}
