/**
 * Page-type-aware text serialization for AI context.
 *
 * Extracted from the read_page tool so command injection (command-resolver)
 * and on-demand reads share one serialization: CODE and markdown pages have
 * natural line structure (and CODE may contain raw HTML/XML that
 * addLineBreaksForAI would mangle) and pass through raw; HTML documents get
 * AI-friendly line breaks.
 */

import { isCodePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { addLineBreaksForAI } from '@/lib/editor/line-breaks';

export interface SerializablePage {
  type: string;
  contentMode: string | null;
  content: string | null;
}

export function serializePageContentForAI(page: SerializablePage): string {
  const isRawText = page.contentMode === 'markdown' || isCodePage(page.type as PageType);
  return isRawText ? (page.content || '') : addLineBreaksForAI(page.content || '');
}

/**
 * Page types whose read_page path returns structured data (transcripts,
 * task lists, file metadata) rather than the page's text content. Those
 * aren't inlineable as a skill body — the AI reads them on demand instead.
 */
const STRUCTURED_READ_TYPES = new Set<string>([
  PageType.CHANNEL,
  PageType.TASK_LIST,
  PageType.FILE,
]);

export function isTextSerializablePageType(type: string): boolean {
  return !STRUCTURED_READ_TYPES.has(type);
}
