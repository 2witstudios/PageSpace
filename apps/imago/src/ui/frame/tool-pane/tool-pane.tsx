'use client';

import type { ReactNode } from 'react';
import type { DriveTool } from '../stage/stage';
import { CalendarPane } from '../../tools/calendar/calendar-pane';
import { AgentsPane } from '../../tools/agents/agents-pane';
import { WorkflowsPane } from '../../tools/workflows/workflows-pane';
import { ActivityPane } from '../../tools/activity/activity-pane';
import { MembersPane } from '../../tools/members/members-pane';
import { TrashPane } from '../../tools/trash/trash-pane';
import { HomeConsolePane } from '../../tools/agents/home-console-pane';
import { useIsHome } from '../drives/home-drive-context';
import { isDashboardTool } from '../drives/home-scope';

import type { ToolPaneProps } from './tool-pane.render';

/**
 * A drive tool's pane, in the shell's left column (SPEC v3.2: every left pane collapses with
 * Close sidebar). The rail opens it alone beside the chat; picking something in it opens the
 * tool's screen in the middle. On Home, the dashboard, Calendar, Console and Activity read
 * across every drive.
 */
export function ToolPane({ tool, driveId, close, variant }: ToolPaneProps & { readonly tool: DriveTool }): ReactNode {
  const allDrives = useIsHome(driveId) && isDashboardTool(tool);
  switch (tool) {
    case 'calendar':
      return <CalendarPane driveId={driveId} close={close} variant={variant} allDrives={allDrives} />;
    case 'agents':
      return allDrives ? <HomeConsolePane driveId={driveId} close={close} variant={variant} /> : <AgentsPane driveId={driveId} close={close} variant={variant} />;
    case 'workflows':
      return <WorkflowsPane driveId={driveId} close={close} variant={variant} />;
    case 'activity':
      return <ActivityPane driveId={driveId} close={close} variant={variant} allDrives={allDrives} />;
    case 'members':
      return <MembersPane driveId={driveId} close={close} variant={variant} />;
    case 'trash':
      return <TrashPane driveId={driveId} close={close} variant={variant} />;
  }
}
