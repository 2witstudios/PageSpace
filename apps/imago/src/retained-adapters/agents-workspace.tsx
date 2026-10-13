'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';
import { RetainedSurface } from './retained-provider';

/** Retain session/directory controls alongside the workspace, inside one Imago stage. */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  return <RetainedSurface><div className="flex h-full min-h-0">
    <aside aria-label="Agent sessions" className="w-60 shrink-0 border-r border-border"><AgentsSidebar /></aside>
    <div className="min-w-0 flex-1"><AgentsSurface driveId={driveId} /></div>
  </div></RetainedSurface>;
}
