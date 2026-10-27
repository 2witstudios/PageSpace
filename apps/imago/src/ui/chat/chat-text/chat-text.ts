// A message's parts as the chat renders them, and the page citations in its
// text. Messages keep the AI SDK `parts` as the server built them; text runs
// become prose and each tool call becomes one summary line, in order. A page
// the agent cites is written the way classic writes every mention,
// `@[label](id:page)` (classic RichText's preprocessMentions); the prose
// turns it into a chip.

import { isToolUIPart } from 'ai';
import type { ChatMessage } from '../chat-model/chat';
import { toolSummary, type ToolCallSummary } from '../tool-summary/tool-summary';

export type MessageBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: ToolCallSummary };

/**
 * Text and tool calls in the order they came. Consecutive text joins (a
 * reasoning or step part between two runs does not split a sentence); a tool
 * call ends the run. Steps, reasoning, files and data parts are not shown.
 */
export const messageBlocks = (parts: ChatMessage['parts']): readonly MessageBlock[] => {
  const blocks: MessageBlock[] = [];
  let text = '';
  const flush = () => {
    if (text.trim() !== '') blocks.push({ kind: 'text', text });
    text = '';
  };
  for (const part of parts) {
    if (part.type === 'text') text += part.text;
    else if (isToolUIPart(part)) {
      flush();
      blocks.push({ kind: 'tool', tool: toolSummary(part) });
    }
  }
  flush();
  return blocks;
};

/** classic RichText's mention pattern. */
const mentionPattern = /@\[([^\]]+)\]\(([^:)]+):([^)]+)\)/g;

/** Page ids are cuid2s; anything else is never put in a link. */
const isPageId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Where the prose finds a citation: a relative link only this module writes. */
const CITE_PREFIX = '/__cite/';

/** Page mentions become citation links; any other mention reads as a plain @name. */
export const citationMarkdown = (text: string): string =>
  text.replace(mentionPattern, (_, label: string, id: string, type: string) =>
    type === 'page' && isPageId(id) ? `[${label}](${CITE_PREFIX}${id})` : `@${label}`,
  );

/** The page a citation link names, or null for any other link. */
export const citedPageId = (href: string | undefined): string | null => {
  if (href === undefined || !href.startsWith(CITE_PREFIX)) return null;
  const id = href.slice(CITE_PREFIX.length);
  return isPageId(id) ? id : null;
};

/** Resolve a citation's authorized actual drive instead of assuming the chat drive. */
export const citationHref = (_driveId: string | null, pageId: string): string =>
  `/p/${encodeURIComponent(pageId)}`;
