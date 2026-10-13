import type { ReactNode } from 'react';
import { getHomeDrive, listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { getViewer } from '@/lib/auth/get-viewer';
import type { DriveSummary } from '@/ui/frame/drives/drives';
import { RetainedProvider } from '@/retained-adapters/retained-provider';
import { Shell } from '@/ui/frame/shell/shell';

/**
 * Every stage, drive-scoped or user-level, shares this one layout, so moving
 * between them (a drive switch included) re-renders only the page below it:
 * the rail, the panes and the chat stay mounted. There is deliberately no
 * loading.tsx here or above: a fallback above the shell could only blank it.
 * The Home drive is where the rail links from the stages that name no drive;
 * the drive list is the one apps/web's GET /api/drives answers with, so the
 * first paint already names the drive and knows one the viewer cannot open.
 */
export default async function ShellLayout({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = await getViewer();
  const [home, drives] = await Promise.all([
    getHomeDrive(viewer.userId),
    listAccessibleDrives(viewer.userId),
  ]);
  const initialDrives: DriveSummary[] = drives.map(({ id, name, kind }) => ({ id, name, kind }));
  return (
    <RetainedProvider><Shell homeDriveId={home?.id ?? null} initialDrives={initialDrives}>
      {children}
    </Shell></RetainedProvider>
  );
}
