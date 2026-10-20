import { redirect } from 'next/navigation';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import { homeSectionPath, type HomeSection, type SearchParams } from './home-section-path';

/**
 * Sends an old /account/<section> link (a bookmark, a retained classic /dashboard/<section> link)
 * on to that section of the viewer's Home drive, the dashboard, with its query. With no Home drive
 * yet it goes to the root, which knows where such a viewer belongs.
 */
export async function redirectToHomeSection(section: HomeSection, searchParams: Promise<SearchParams>): Promise<never> {
  const viewer = await getViewer();
  const home = await getHomeDrive(viewer.userId);
  redirect(home ? homeSectionPath(home.id, section, await searchParams) : '/');
}
