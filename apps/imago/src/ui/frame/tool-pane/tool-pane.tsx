'use client';

import type { ReactNode } from 'react';
import type { DriveTool } from '../stage/stage';
import { CalendarPane } from '../../tools/calendar/calendar-pane';
import { ConsolePane } from '../../tools/agents/console-pane';
import { WorkflowsPane } from '../../tools/workflows/workflows-pane';
import { ActivityPane } from '../../tools/activity/activity-pane';
import { MembersPane } from '../../tools/members/members-pane';
import { FilesPane } from '../../files/files-pane/files-pane';

import type { ToolPaneProps } from './tool-pane.render';

/**
 * A drive tool's 260px pane, in the shell's left column (SPEC v3.2: every left pane collapses with
 * Close sidebar). Trash keeps the Files pane beside it, as C-Drive-Trash draws.
 */
export function ToolPane({ tool, driveId, close }: ToolPaneProps & { readonly tool: DriveTool }): ReactNode {
  switch (tool) {
    case 'calendar':
      return <CalendarPane driveId={driveId} close={close} />;
    case 'agents':
      return <ConsolePane driveId={driveId} close={close} />;
    case 'workflows':
      return <WorkflowsPane driveId={driveId} close={close} />;
    case 'activity':
      return <ActivityPane driveId={driveId} close={close} />;
    case 'members':
      return <MembersPane driveId={driveId} close={close} />;
    case 'trash':
      return <FilesPane driveId={driveId} selectedPageId={null} variant="tree" title="Files" />;
  }
}
