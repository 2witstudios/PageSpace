/**
 * Page-type-aware text serialization for AI context.
 *
 * Extracted from the read_page tool so command injection (command-resolver)
 * and on-demand reads share one serialization: CODE and markdown pages have
 * natural line structure (and CODE may contain raw HTML/XML that
 * addLineBreaksForAI would mangle) and pass through raw; HTML documents get
 * AI-friendly line breaks.
 *
 * The write paths (`replace_lines`, the MCP documents route) count lines
 * against this same projection and store it back verbatim — see
 * `@/lib/editor/line-edit` for why that identity is what keeps a document
 * from being edited against line numbers it no longer has.
 */

import { isCodePage } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { hasLineStructuringHtml } from '@/lib/editor/line-breaks';
import { canonicalizeForLineEditing } from '@/lib/editor/line-edit';

export interface SerializablePage {
  type: string;
  contentMode: string | null;
  content: string | null;
}

/**
 * True for content whose lines are its own newlines — markdown documents and
 * CODE pages — as opposed to HTML that has to be line-broken first.
 */
export function isRawTextPage(page: Pick<SerializablePage, 'type' | 'contentMode'>): boolean {
  return page.contentMode === 'markdown' || isCodePage(page.type as PageType);
}

export function serializePageContentForAI(page: SerializablePage): string {
  return canonicalizeForLineEditing(page.content, isRawTextPage(page));
}

/**
 * An html-mode page whose content is not HTML — raw JSON, markdown, plain
 * prose. These predate content modes (everything defaulted to html) and are
 * what #2463 was reported against: the normalizer has nothing to break on, so
 * the page's line numbers are simply the text's own newlines. That works, but
 * only by accident of the mode not mattering, and a single stray block tag in
 * the payload would change the numbering underneath the agent. Say so rather
 * than letting the agent discover it by corrupting the document.
 *
 * @returns the warning to surface, or undefined when the page is consistent.
 */
export function describeContentModeMismatch(page: SerializablePage): string | undefined {
  // DOCUMENT only: contentMode is a document concept. A SHEET serializes from
  // its rows and a FILE from extracted text — neither is HTML, and neither is
  // line-editable, so warning about their mode would be noise.
  if (page.type !== PageType.DOCUMENT) return undefined;
  if (isRawTextPage(page)) return undefined;
  if (page.contentMode !== 'html') return undefined;
  const content = page.content ?? '';
  if (content.trim() === '') return undefined;
  if (hasLineStructuringHtml(content)) return undefined;

  // Deliberately does NOT tell the agent to call
  // /api/pages/{pageId}/convert-content-mode: that route is session-auth only,
  // so an MCP/API-key principal cannot reach it. Naming an action the reader
  // cannot take is how a warning turns into a dead end.
  return (
    'This page is in html contentMode but holds content with no HTML block structure ' +
    '(raw JSON, markdown or plain text). Its line numbers are the text\'s own newlines, ' +
    'which is what you want — but writing HTML into it would renumber the whole document, ' +
    'so keep the content in the shape it is already in. New documents you create default ' +
    'to markdown mode; a person can convert this one from the document\'s content-mode ' +
    'menu in the app.'
  );
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
