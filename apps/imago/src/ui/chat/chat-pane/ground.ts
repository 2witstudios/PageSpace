import type { Stage } from '@/ui/frame/stage/stage';

/** What sits above the thread when no object is open: the Files intro, the people you can message, or a drive's tasks. */
export type Ground = 'files' | 'dm' | 'tasks' | null;

export const groundFor = (stage: Stage): Ground => {
  if (stage.object !== null) return null;
  if (stage.section === 'files') return stage.driveId === null ? null : 'files';
  if (stage.section === 'messages') return stage.driveId === null ? 'dm' : null;
  if (stage.section === 'tasks') return stage.driveId === null ? null : 'tasks';
  return null;
};
