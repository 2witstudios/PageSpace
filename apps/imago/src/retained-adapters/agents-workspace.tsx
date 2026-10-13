'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';
import { SessionToolbar } from '@/ui/tools/agents/session-toolbar';
import { RetainedSurface } from './retained-provider';

/**
 * The Agents middle: the selected session's toolbar over its surface. On a drive the session list
 * is the Agents pane in the shell's left column (ui/tools/agents/agents-pane.tsx). The global
 * account route has no drive tool pane, so it keeps the sidebar as its session list.
 */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  return <RetainedSurface><div className="flex h-full min-h-0">
    {driveId ? null : <aside aria-label="Agent sessions" className="w-60 shrink-0 border-r border-border"><AgentsSidebar /></aside>}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionToolbar driveId={driveId} />
      <div className="min-h-0 min-w-0 flex-1"><AgentsSurface driveId={driveId} /></div>
    </div>
  </div></RetainedSurface>;
}
