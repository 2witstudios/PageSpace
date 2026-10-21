import { toolOf, type Stage } from '../stage/stage';
import { NO_SCOPES, resolveScope, type SectionScopes } from './section-scope';

/**
 * Every drive's view (ADR 0007 D4, amended): Messages, Tasks, Files, Calendar, Console and
 * Activity each carry a scope switch in their head, this drive or All drives, held per section
 * (section-scope.ts) and All drives on Home until the viewer picks otherwise. The chat on Home
 * still reads every drive. Workflows, Members, Trash and the drive settings are always the
 * drive's own.
 *
 * Whether the stage claims no drive for the chat: Home's chat, or Messages, Tasks or a drive
 * tool switched to All drives. Files' All drives is a list of drives, so the chat stays in the
 * drive the viewer is standing in.
 */
export const isDashboard = (stage: Stage, homeDriveId: string | null, scopes: SectionScopes = NO_SCOPES): boolean => {
  if (stage.driveId === null) return false;
  const isHome = homeDriveId !== null && stage.driveId === homeDriveId;
  if (stage.section === 'chat') return isHome;
  if (stage.section === 'messages' || stage.section === 'tasks') return resolveScope(scopes, stage.section, isHome) === 'all';
  const tool = toolOf(stage);
  if (tool === 'calendar' || tool === 'agents' || tool === 'activity') return resolveScope(scopes, tool, isHome) === 'all';
  return false;
};
