'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import { SessionToolbar } from '@/ui/tools/agents/session-toolbar';
import { RetainedSurface } from './retained-provider';

/**
 * The Agents middle: the selected session's toolbar over its surface. The session list is the
 * pane in the shell's left column: the drive's (ui/tools/agents/agents-pane.tsx), or on Home with
 * no drive every drive's (ui/tools/agents/account-agents-pane.tsx).
 */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  return <RetainedSurface><div className="flex h-full min-h-0">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionToolbar driveId={driveId} />
      <div className="min-h-0 min-w-0 flex-1"><AgentsSurface driveId={driveId} /></div>
    </div>
  </div></RetainedSurface>;
}
