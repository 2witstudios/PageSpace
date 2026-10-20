'use client';

import type { ReactNode } from 'react';
import type { DriveTool } from '../stage/stage';
import { CalendarPane } from '../../tools/calendar/calendar-pane';
import { AgentsPane } from '../../tools/agents/agents-pane';
import { WorkflowsPane } from '../../tools/workflows/workflows-pane';
import { ActivityPane } from '../../tools/activity/activity-pane';
import { MembersPane } from '../../tools/members/members-pane';
import { FilesPane } from '../../files/files-pane/files-pane';
import { HomeConsolePane } from '../../tools/agents/home-console-pane';
import { useIsHome } from '../drives/home-drive-context';
import { isDashboardTool } from '../drives/home-scope';

import type { ToolPaneProps } from './tool-pane.render';

/**
 * A drive tool's 260px pane, in the shell's left column (SPEC v3.2: every left pane collapses with
 * Close sidebar). Trash keeps the Files pane beside it, as C-Drive-Trash draws. On Home, the
 * dashboard, Calendar, Console and Activity read across every drive.
 */
export function ToolPane({ tool, driveId, close }: ToolPaneProps & { readonly tool: DriveTool }): ReactNode {
  const allDrives = useIsHome(driveId) && isDashboardTool(tool);
  switch (tool) {
    case 'calendar':
      return <CalendarPane driveId={driveId} close={close} allDrives={allDrives} />;
    case 'agents':
      return allDrives ? <HomeConsolePane driveId={driveId} close={close} /> : <AgentsPane driveId={driveId} close={close} />;
    case 'workflows':
      return <WorkflowsPane driveId={driveId} close={close} />;
    case 'activity':
      return <ActivityPane driveId={driveId} close={close} allDrives={allDrives} />;
    case 'members':
      return <MembersPane driveId={driveId} close={close} />;
    case 'trash':
      return <FilesPane driveId={driveId} selectedPageId={null} variant="tree" title="Files" />;
  }
}
