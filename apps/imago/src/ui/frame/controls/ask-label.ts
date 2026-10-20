import { toolOf, type Stage } from '../stage/stage';

/** The tools whose boards word the head's Ask pill for what is on screen (C-Drive-Calendar, -Activity, -Workflows). */
const toolAsks: Readonly<Partial<Record<string, string>>> = {
  calendar: 'Ask about this week',
  activity: 'Ask what changed',
  workflows: 'Ask why it failed',
};

/** The Ask pill's words: the tool's own question where its board has one, else "Ask". */
export const askLabelFor = (stage: Stage): string => {
  const tool = toolOf(stage);
  return (tool === null ? undefined : toolAsks[tool]) ?? 'Ask';
};
