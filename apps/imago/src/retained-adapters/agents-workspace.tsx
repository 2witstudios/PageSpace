'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';
import { SessionToolbar } from '@/ui/tools/agents/session-toolbar';
import { RetainedSurface } from './retained-provider';

/**
 * The Console middle: the selected session's pane grid. On a drive the session list is the
 * Console pane in the shell's left column (ui/tools/agents/console-pane.tsx) and the session
 * bar is the middle's head, which the shell draws; with no session selected the shell hands
 * the middle to Imago. The account route has no drive tool pane, so it carries classic's
 * Agents sidebar across the viewer's drives, and its own session bar.
 */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  return <RetainedSurface><div className="flex h-full min-h-0">
    {driveId ? null : (
      <aside aria-label="Agent sessions" className="flex w-64 flex-none flex-col border-r border-border">
        <AgentsSidebar />
      </aside>
    )}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {driveId ? null : <SessionToolbar />}
      <div className="min-h-0 min-w-0 flex-1"><AgentsSurface driveId={driveId} /></div>
    </div>
  </div></RetainedSurface>;
}
