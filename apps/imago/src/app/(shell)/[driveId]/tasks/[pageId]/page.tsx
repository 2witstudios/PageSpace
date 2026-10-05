import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { TaskListView } from '@/ui/tasks/task-list-view/task-list-view';

type Props = { readonly params: Promise<{ driveId: string; pageId: string }> };

/** Stage 3: the lists, the open task list and the fixed chat. The route renders only the object slot's content. */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const viewer = await getViewer();
  const { driveId, pageId } = await params;
  return <TaskListView driveId={driveId} pageId={pageId} viewerId={viewer.userId} />;
}
