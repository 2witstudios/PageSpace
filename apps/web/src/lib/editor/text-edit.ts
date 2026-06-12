/**
 * Text-based document editing (pure)
 *
 * find_and_replace: string-match replacement, more resilient than line-based
 * editing because it doesn't depend on stable line numbers.
 *
 * insertAtAnchor: insert a block before or after the first line that contains
 * a given anchor string — natural for agents that think in terms of headings
 * and landmarks rather than line offsets.
 *
 * Both functions normalize HTML content via addLineBreaksForAI before
 * operating, matching the same invariant as replaceLines so that the returned
 * oldContent/newContent pair can be diffed cleanly.
 */

import { addLineBreaksForAI } from './line-breaks';

// ─── findAndReplace ──────────────────────────────────────────────────────────

export interface FindAndReplaceParams {
  content: string | null | undefined;
  search: string;
  replacement: string;
  /** Replace every occurrence. Defaults to false (first match only). */
  replaceAll?: boolean;
  isRawText: boolean;
}

export interface FindAndReplaceResult {
  /** Diff baseline, normalized identically to newContent. */
  oldContent: string;
  /** Content after replacement. */
  newContent: string;
  /** Number of replacements made (0 when not found). */
  matchCount: number;
  /** Whether the search string was present. */
  found: boolean;
}

export function findAndReplace(params: FindAndReplaceParams): FindAndReplaceResult {
  const { content, search, replacement, replaceAll = false, isRawText } = params;

  if (!search) {
    throw new Error('Search string cannot be empty');
  }

  const oldContent = isRawText ? (content ?? '') : addLineBreaksForAI(content ?? '');

  if (!oldContent.includes(search)) {
    return { oldContent, newContent: oldContent, matchCount: 0, found: false };
  }

  if (replaceAll) {
    const parts = oldContent.split(search);
    const matchCount = parts.length - 1;
    return { oldContent, newContent: parts.join(replacement), matchCount, found: true };
  }

  const idx = oldContent.indexOf(search);
  const newContent = oldContent.slice(0, idx) + replacement + oldContent.slice(idx + search.length);
  return { oldContent, newContent, matchCount: 1, found: true };
}

// ─── insertAtAnchor ──────────────────────────────────────────────────────────

export interface InsertAtAnchorParams {
  content: string | null | undefined;
  /** Substring to search for within a line. First matching line wins. */
  anchor: string;
  /** Text to insert as a new line. */
  insertion: string;
  position: 'before' | 'after';
  isRawText: boolean;
}

export interface InsertAtAnchorResult {
  /** Diff baseline, normalized identically to newContent. */
  oldContent: string;
  /** Content with the insertion applied. */
  newContent: string;
  /** Whether the anchor was found and the insertion was made. */
  inserted: boolean;
  /** 1-based line number of the anchor (null when not found). */
  anchorLine: number | null;
}

export function insertAtAnchor(params: InsertAtAnchorParams): InsertAtAnchorResult {
  const { content, anchor, insertion, position, isRawText } = params;

  if (!anchor) {
    throw new Error('Anchor string cannot be empty');
  }

  const oldContent = isRawText ? (content ?? '') : addLineBreaksForAI(content ?? '');
  const lines = oldContent.split('\n');

  const anchorIndex = lines.findIndex(line => line.includes(anchor));

  if (anchorIndex === -1) {
    return { oldContent, newContent: oldContent, inserted: false, anchorLine: null };
  }

  let insertAt = position === 'before' ? anchorIndex : anchorIndex + 1;

  // For HTML pages, snap to the block boundary so insertion lands outside the
  // containing element rather than inside it.
  // after:  advance past all immediately following closing tags (</tag>)
  // before: back up past the one opening tag immediately preceding the anchor
  if (!isRawText) {
    if (position === 'after') {
      while (insertAt < lines.length && lines[insertAt].trimStart().startsWith('</')) {
        insertAt++;
      }
    } else if (insertAt > 0 && /^\s*<[^/!]/.test(lines[insertAt - 1])) {
      insertAt--;
    }
  }

  const newLines = [...lines.slice(0, insertAt), insertion, ...lines.slice(insertAt)];

  return {
    oldContent,
    newContent: newLines.join('\n'),
    inserted: true,
    anchorLine: anchorIndex + 1,
  };
}
