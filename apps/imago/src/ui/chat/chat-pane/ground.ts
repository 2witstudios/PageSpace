import type { Stage } from '@/ui/frame/stage/stage';

/** What sits above the thread when no object is open: the Files intro, a drive's unread counts, or the people you can message. */
export type Ground = 'files' | 'messages' | 'dm' | null;

export const groundFor = (stage: Stage): Ground => {
  if (stage.object !== null) return null;
  if (stage.section === 'files') return stage.driveId === null ? null : 'files';
  if (stage.section === 'messages') return stage.driveId === null ? 'dm' : 'messages';
  return null;
};
