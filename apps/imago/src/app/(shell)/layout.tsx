import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { Shell } from '@/ui/frame/shell/shell';

/**
 * Every stage, drive-scoped or user-level, shares this one layout, so moving
 * between them (a drive switch included) re-renders only the page below it:
 * the rail, the panes and the chat stay mounted. There is deliberately no
 * loading.tsx here or above: a fallback above the shell could only blank it.
 */
export default async function ShellLayout({ children }: Readonly<{ children: ReactNode }>) {
  await getViewer();
  return <Shell>{children}</Shell>;
}
