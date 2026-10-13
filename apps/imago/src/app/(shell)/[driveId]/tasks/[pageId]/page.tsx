import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { TaskObject } from '@/ui/tasks/task-object/task-object';

type Props = { readonly params: Promise<{ driveId: string; pageId: string }> };

/**
 * Stage 3: the lists, the open object and the fixed chat. The id names a task
 * list (its view) or a task (its detail); the route renders only the object
 * slot's content.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const viewer = await getViewer();
  const { driveId, pageId } = await params;
  return <TaskObject driveId={driveId} pageId={pageId} viewerId={viewer.userId} />;
}
