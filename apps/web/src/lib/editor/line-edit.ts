/**
 * Line-based document editing (pure)
 *
 * Encapsulates the line-replacement used by the `replace_lines` AI tool.
 *
 * The stored page content is raw TipTap/ProseMirror HTML with no line breaks.
 * To support line-based editing, HTML is normalized via `addLineBreaksForAI`
 * so it has one block per line. The critical invariant is that the returned
 * `oldContent` (diff baseline) is normalized with the *same* function as
 * `newContent` — otherwise a single-line edit diffs as a full-document
 * replacement, because raw HTML and line-broken HTML share almost no lines.
 */

import { addLineBreaksForAI } from './line-breaks';

export interface ReplaceLinesParams {
  /** Raw stored page content (may be null). */
  content: string | null | undefined;
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** Replacement text; an empty string deletes the range. */
  replacement: string;
  /**
   * True for content with natural line structure (markdown, code) where
   * `addLineBreaksForAI` must NOT be applied; false for HTML documents.
   */
  isRawText: boolean;
}

export interface ReplaceLinesResult {
  /** Diff baseline, normalized identically to `newContent`. */
  oldContent: string;
  /** Edited content, normalized identically to `oldContent`. */
  newContent: string;
  /** Number of source lines that were replaced or removed. */
  linesReplaced: number;
  /** Line count of the resulting content. */
  newLineCount: number;
  changeType: 'deletion' | 'replacement';
}

/**
 * Replace an inclusive 1-based line range with `replacement`, returning both
 * the normalized baseline and result so they can be diffed line-for-line.
 *
 * @throws if the line range is out of bounds or inverted.
 */
export function replaceLines(params: ReplaceLinesParams): ReplaceLinesResult {
  const { content, startLine, endLine, replacement, isRawText } = params;

  const oldContent = isRawText ? (content || '') : addLineBreaksForAI(content || '');
  const lines = oldContent.split('\n');

  if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
    throw new Error(
      `Invalid line range: ${startLine}-${endLine}. Document has ${lines.length} lines.`
    );
  }

  const isDeletion = replacement.length === 0;
  const replacementSegment = isDeletion ? [] : [replacement];
  const newLines = [
    ...lines.slice(0, startLine - 1),
    ...replacementSegment,
    ...lines.slice(endLine),
  ];

  return {
    oldContent,
    newContent: newLines.join('\n'),
    linesReplaced: endLine - startLine + 1,
    newLineCount: newLines.length,
    changeType: isDeletion ? 'deletion' : 'replacement',
  };
}
