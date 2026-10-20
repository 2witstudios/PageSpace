import { toolOf, type DriveTool, type Stage } from '../stage/stage';

/**
 * Home is the dashboard (ADR 0007 D4, amended; useIsHome in home-drive-context.tsx tells a screen
 * whether its drive is Home): on the viewer's Home drive the
 * chat, Messages, Tasks, Calendar, Console and Activity read across every
 * drive the viewer can reach, as classic's All drives did. Files, Workflows,
 * Members, Trash and the drive settings stay Home's own.
 */
const dashboardTools: readonly DriveTool[] = ['calendar', 'agents', 'activity'];

/** Whether a drive tool reads across every drive when it is opened on Home. */
export const isDashboardTool = (tool: DriveTool): boolean => dashboardTools.includes(tool);

/** Whether the stage shows the all-drives view: one of Home's aggregate sections. */
export const isDashboard = (stage: Stage, homeDriveId: string | null): boolean => {
  if (homeDriveId === null || stage.driveId !== homeDriveId) return false;
  if (stage.section === 'chat' || stage.section === 'messages' || stage.section === 'tasks') return true;
  const tool = toolOf(stage);
  return tool !== null && isDashboardTool(tool);
};
