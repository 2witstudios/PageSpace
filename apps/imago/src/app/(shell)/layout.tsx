import type { ReactNode } from 'react';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import { Shell } from '@/ui/frame/shell/shell';

/**
 * Every stage, drive-scoped or user-level, shares this one layout, so moving
 * between them (a drive switch included) re-renders only the page below it:
 * the rail, the panes and the chat stay mounted. There is deliberately no
 * loading.tsx here or above: a fallback above the shell could only blank it.
 * The Home drive is where the rail links from the stages that name no drive.
 */
export default async function ShellLayout({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = await getViewer();
  const home = await getHomeDrive(viewer.userId);
  return <Shell homeDriveId={home?.id ?? null}>{children}</Shell>;
}
