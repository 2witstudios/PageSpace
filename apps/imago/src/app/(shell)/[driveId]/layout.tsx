import type { ReactNode } from 'react';
import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import { DRIVE_NOT_FOUND, renderNotFound } from '@/ui/frame/not-found/not-found.render';

/**
 * The drive gate. A drive id in the URL is the client's claim; access is the
 * server's answer. A drive the viewer cannot reach (or that does not exist:
 * the answer is the same) renders the not-found object in place of every
 * route below, so no drive route renders for it. The shell, which knows the
 * same from the drive list, opens the object column to show it.
 */
export default async function DriveLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ driveId: string }> }>): Promise<ReactNode> {
  const viewer = await getViewer();
  const { driveId } = await params;
  if (!(await getUserDriveAccess(viewer.userId, driveId))) {
    const home = await getHomeDrive(viewer.userId);
    return renderNotFound({
      ...DRIVE_NOT_FOUND,
      homeHref: home === null ? null : `/${encodeURIComponent(home.id)}`,
    });
  }
  return children;
}
