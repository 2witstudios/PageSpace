'use client';

import type { ReactNode } from 'react';
import type { DriveTool } from '../stage/stage';
import { CalendarPane } from '../../tools/calendar/calendar-pane';
import { ConsolePane } from '../../tools/agents/console-pane';
import { WorkflowsPane } from '../../tools/workflows/workflows-pane';
import { ActivityPane } from '../../tools/activity/activity-pane';
import { MembersPane } from '../../tools/members/members-pane';
import { TrashPane } from '../../tools/trash/trash-pane';
import { ScopeSwitch } from '../drives/scope-switch';
import { useSectionScopes } from '../drives/use-section-scope';
import { useIsHome } from '../drives/home-drive-context';
import { hasScope, resolveScope } from '../drives/section-scope';

import type { ToolPaneProps } from './tool-pane.render';

/**
 * A drive tool's pane, in the shell's left column (SPEC v3.2: every left pane collapses with
 * Close sidebar). The rail opens it alone beside the chat; picking something in it opens the
 * tool's screen in the middle. Calendar, Console and Activity carry a scope switch in their
 * head: this drive, or every drive.
 */
export function ToolPane({ tool, driveId, close, variant }: ToolPaneProps & { readonly tool: DriveTool }): ReactNode {
  const scopes = useSectionScopes();
  const isHome = useIsHome(driveId);
  const scoped = hasScope(tool) ? tool : null;
  const allDrives = scoped !== null && resolveScope(scopes, scoped, isHome) === 'all';
  const scope = scoped === null ? null : <ScopeSwitch section={scoped} driveId={driveId} />;
  switch (tool) {
    case 'calendar':
      return <CalendarPane driveId={driveId} close={close} variant={variant} scope={scope} allDrives={allDrives} />;
    case 'agents':
      return <ConsolePane driveId={driveId} close={close} variant={variant} scope={scope} allDrives={allDrives} />;
    case 'workflows':
      return <WorkflowsPane driveId={driveId} close={close} variant={variant} />;
    case 'activity':
      return <ActivityPane driveId={driveId} close={close} variant={variant} scope={scope} allDrives={allDrives} />;
    case 'members':
      return <MembersPane driveId={driveId} close={close} variant={variant} />;
    case 'trash':
      return <TrashPane driveId={driveId} close={close} variant={variant} />;
  }
}
