// What a page of the Files section that imago does not draw hands off to:
// classic PageSpace for its own view, and, for an agent page, the chat.

import { getPageTypeConfig, PageType, type PageTypeValue } from '@pagespace/lib/client-safe';
import type { IconName } from '../../components/icon/icon-names';
import type { ChatAgent } from '../../chat/chat-model/chat';
import { classicHref } from '../../frame/rail/rail-items';
import { fileIcon } from '../tree-view/tree-view';

/** The object card for a page imago hands off. */
export type Handoff = {
  /** The page type's name as classic shows it, e.g. "Sheet". */
  readonly typeLabel: string;
  readonly icon: IconName;
  readonly title: string;
  /** The page in classic, a same-origin path outside /imago. */
  readonly classicHref: string;
  /** The agent to chat with, for an agent page; null for any other. */
  readonly agent: ChatAgent | null;
};

/**
 * The page types imago has no view for. A task list opens in Tasks, but
 * Files shows it as any other page, so here it hands off too.
 */
const handedOff: ReadonlySet<string> = new Set<PageTypeValue>([
  PageType.SHEET,
  PageType.CANVAS,
  PageType.CODE,
  PageType.FILE,
  PageType.TASK_LIST,
  PageType.AI_CHAT,
]);

const isHandedOff = (type: unknown): type is PageTypeValue => typeof type === 'string' && handedOff.has(type);

const nameOf = (title: unknown): string => (typeof title === 'string' && title.trim() !== '' ? title : 'Untitled');

/**
 * The card for GET /api/pages/[pageId]'s answer, or null when imago draws the
 * page itself (or the answer is not in yet). The page's place was settled by
 * PageObject's gate, so only its type and title are read here.
 */
export const handoffFor = (data: unknown, driveId: string, pageId: string): Handoff | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { type, title } = data as { type?: unknown; title?: unknown };
  if (!isHandedOff(type)) return null;
  const name = nameOf(title);
  return {
    typeLabel: getPageTypeConfig(type as PageType).displayName,
    icon: fileIcon(type),
    title: name,
    classicHref: classicHref(driveId, encodeURIComponent(pageId)),
    agent: type === PageType.AI_CHAT ? { id: pageId, title: name } : null,
  };
};
