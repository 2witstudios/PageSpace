import type { ChatAgent } from '../../chat/chat-model/chat';
import type { PaletteResult } from '../palette-search/palette-search';

/** Where picking a result goes, basePath-relative, and the agent the chat should talk to there. */
export type PaletteDestination = {
  readonly href: string;
  /** Set for an agent: the chat header switches to it on arrival. */
  readonly agent: ChatAgent | null;
};

const segment = (id: string): string => encodeURIComponent(id);

/**
 * A result's imago route, in its own drive: a channel in Messages, a task
 * list in Tasks, an agent as the drive chat's agent, and every other page in
 * Files (whose object view sends sheets, canvases, code and files on to
 * classic, DEC-9). Each id is escaped into one segment.
 */
export const destinationFor = (result: PaletteResult): PaletteDestination => {
  const drive = `/${segment(result.driveId)}`;
  const page = segment(result.id);
  switch (result.pageType) {
    case 'CHANNEL':
      return { href: `${drive}/messages/${page}`, agent: null };
    case 'TASK_LIST':
      return { href: `${drive}/tasks/${page}`, agent: null };
    case 'AI_CHAT':
      return { href: drive, agent: { id: result.id, title: result.title } };
    default:
      return { href: `${drive}/files/${page}`, agent: null };
  }
};
