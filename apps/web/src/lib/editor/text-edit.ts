/**
 * Text-based document editing (pure)
 *
 * insertAtAnchor: insert a block before or after the first line that contains
 * a given anchor string — natural for agents that think in terms of headings
 * and landmarks rather than line offsets.
 *
 * Normalizes HTML content via canonicalizeForLineEditing before operating and
 * again after, matching the same invariant as replaceLines: the oldContent/
 * newContent pair diffs cleanly, and the stored content is the same projection
 * a read returns, so `newLineCount` is the count the next read reports.
 */

import { canonicalizeForLineEditing } from './line-edit';

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
  /** Content with the insertion applied, canonicalized for line numbering. */
  newContent: string;
  /** Line count of `newContent` — what a subsequent read of the page returns. */
  newLineCount: number;
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

  const oldContent = canonicalizeForLineEditing(content, isRawText);
  const lines = oldContent.split('\n');

  const anchorIndex = lines.findIndex(line => line.includes(anchor));

  if (anchorIndex === -1) {
    return {
      oldContent,
      newContent: oldContent,
      newLineCount: lines.length,
      inserted: false,
      anchorLine: null,
    };
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

  const newLines = [...lines.slice(0, insertAt), ...insertion.split('\n'), ...lines.slice(insertAt)];
  const newContent = canonicalizeForLineEditing(newLines.join('\n'), isRawText);

  return {
    oldContent,
    newContent,
    newLineCount: newContent.split('\n').length,
    inserted: true,
    anchorLine: anchorIndex + 1,
  };
}
