import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/get-viewer';

/** /tasks/view names no smart view: the Tasks pane alone, rather than a task list page called "view". */
export default async function Page({ params }: { readonly params: Promise<{ readonly driveId: string }> }): Promise<never> {
  const [{ driveId }] = await Promise.all([params, getViewer()]);
  redirect(`/${encodeURIComponent(driveId)}/tasks`);
}
