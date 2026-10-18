import type { PageTypeValue } from '@pagespace/lib/utils/enums';
import type { IconName } from '../icon/icon-names';

/**
 * Each page type's icon and hue, as the boards draw them (SPEC "Page-type icons + colors as
 * in Spine.dc.html"): documents blue, task lists green, sheets teal, channels purple, folders
 * amber, agents red-orange, canvases pink, code slate, files grey.
 */
export const pageTypeIcons: Readonly<Record<PageTypeValue, { readonly icon: IconName; readonly hue: string }>> = {
  DOCUMENT: { icon: 'page', hue: 'text-type-doc' },
  TASK_LIST: { icon: 'tasks', hue: 'text-type-tasks' },
  SHEET: { icon: 'sheet', hue: 'text-type-sheet' },
  CHANNEL: { icon: 'hash', hue: 'text-type-channel' },
  FOLDER: { icon: 'folder', hue: 'text-type-folder' },
  AI_CHAT: { icon: 'bot', hue: 'text-type-agent' },
  CANVAS: { icon: 'canvas', hue: 'text-type-canvas' },
  CODE: { icon: 'code', hue: 'text-type-code' },
  FILE: { icon: 'file', hue: 'text-type-file' },
};
