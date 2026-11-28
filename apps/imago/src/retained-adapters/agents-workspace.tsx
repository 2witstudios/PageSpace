'use client';

import AgentsSurface from '@/retained/components/agents/AgentsSurface';
import { RetainedSurface } from './retained-provider';

/**
 * The Console middle: the selected session's pane grid. The session list is the Console pane
 * in the shell's left column (ui/tools/agents/console-pane.tsx), every drive's on Home, and the
 * session bar is the middle's head, which the shell draws. With no session selected the shell
 * hands the middle to Imago, and on a phone the Console pane is the screen itself.
 */
export function AgentsWorkspace({ driveId }: { driveId?: string }) {
  return <RetainedSurface><AgentsSurface driveId={driveId} /></RetainedSurface>;
}
