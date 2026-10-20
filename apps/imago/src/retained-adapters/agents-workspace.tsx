'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import { useHomeDriveId } from '@/ui/frame/drives/home-drive-context';
import { usePhone } from '@/ui/frame/viewport/use-viewport-tier';
import { HomeConsolePane } from '@/ui/tools/agents/home-console-pane';
import { SessionToolbar } from '@/ui/tools/agents/session-toolbar';
import { RetainedSurface } from './retained-provider';

/**
 * The Agents middle: the selected session's toolbar over its surface. The session list is the
 * pane in the shell's left column: the drive's (ui/tools/agents/agents-pane.tsx), or on Home with
 * no drive every drive's (ui/tools/agents/home-console-pane.tsx). A phone shows no tool pane,
 * so there Home carries the every-drive list itself, and its sessions stay reachable.
 */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  const phone = usePhone();
  const homeDriveId = useHomeDriveId();
  return <RetainedSurface><div className="flex h-full min-h-0">
    {!driveId && phone && homeDriveId ? <HomeConsolePane driveId={homeDriveId} close={null} /> : null}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionToolbar driveId={driveId} />
      <div className="min-h-0 min-w-0 flex-1"><AgentsSurface driveId={driveId} /></div>
    </div>
  </div></RetainedSurface>;
}
