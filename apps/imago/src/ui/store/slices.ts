import { chatPlugin } from '../chat/chat-plugin';
import { filesPlugin } from '../files/files-plugin/files-plugin';
import { stagePlugin } from '../frame/stage/stage-plugin';
import { palettePlugin } from '../palette/palette-plugin';
import { tasksPlugin } from '../tasks/tasks-plugin';

/**
 * Every section's store slice, listed once. A new section adds its slice
 * module in its own folder and one line here; state.ts and transactions.ts
 * compose the shell from this list and refuse a resource key or transaction
 * name two slices share.
 */
export const uiSlices = [stagePlugin, tasksPlugin, filesPlugin, chatPlugin, palettePlugin] as const;
