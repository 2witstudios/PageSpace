import { redirect } from 'next/navigation';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';

/** The cross-drive views the account once held, now Home's own sections (ADR 0007 D4, amended). */
export type HomeSection = 'tasks' | 'calendar' | 'activity' | 'agents' | 'messages';

/**
 * Sends an old /account/<section> link (a bookmark, a retained classic /dashboard/<section> link)
 * on to that section of the viewer's Home drive, the dashboard. With no Home drive yet it goes to
 * the root, which knows where such a viewer belongs.
 */
export async function redirectToHomeSection(section: HomeSection): Promise<never> {
  const viewer = await getViewer();
  const home = await getHomeDrive(viewer.userId);
  redirect(home ? `/${encodeURIComponent(home.id)}/${section}` : '/');
}
