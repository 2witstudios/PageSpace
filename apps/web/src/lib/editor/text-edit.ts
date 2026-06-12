/**
 * Text-based document editing (pure)
 *
 * insertAtAnchor: insert a block before or after the first line that contains
 * a given anchor string — natural for agents that think in terms of headings
 * and landmarks rather than line offsets.
 *
 * Normalizes HTML content via addLineBreaksForAI before operating, matching
 * the same invariant as replaceLines so the oldContent/newContent pair diffs cleanly.
 */

import { addLineBreaksForAI } from './line-breaks';

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
  // before: back up past all immediately preceding opening tags (<tag>)
  if (!isRawText) {
    if (position === 'after') {
      while (insertAt < lines.length && lines[insertAt].trimStart().startsWith('</')) {
        insertAt++;
      }
    } else {
      while (insertAt > 0 && /^\s*<[^/!]/.test(lines[insertAt - 1])) {
        insertAt--;
      }
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
