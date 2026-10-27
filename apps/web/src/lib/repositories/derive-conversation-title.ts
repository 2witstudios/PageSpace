/**
 * Derives a short conversation title from a message's raw content.
 * PurePoint-style cleanup (ClaudeConversationIndex.swift:411-434,372-385) —
 * pure string logic, no LLM.
 */

const PLAN_BOILERPLATE_PREFIX_RE = /^implement the following plan:\s*/i;
const FILLER_PREFIX_RE = /^(can you |could you |please |help me |i need to |i want to )/i;
const LEADING_HEADING_RE = /^#+\s*/;
const MAX_LENGTH = 50;

export function deriveConversationTitle(content: string): string {
  const cleaned = content
    .replace(PLAN_BOILERPLATE_PREFIX_RE, '')
    .replace(FILLER_PREFIX_RE, '');

  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  const title = firstLine.replace(LEADING_HEADING_RE, '');

  if (title.length <= MAX_LENGTH) return title;
  return title.slice(0, MAX_LENGTH) + '...';
}
