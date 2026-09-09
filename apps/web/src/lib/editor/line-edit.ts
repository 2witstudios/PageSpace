/**
 * Line-based document editing (pure)
 *
 * The single line-accounting rule for the whole product. Both surfaces that
 * edit a document by line number go through here:
 *   - the in-app AI tools (`replace_lines`)
 *   - the MCP/HTTP route (`/api/mcp/documents`, used by the CLI and SDK)
 * They used to carry two implementations that disagreed with each other, which
 * is how #2463 corrupted a document: one surface reported a line count it had
 * computed BEFORE normalizing what it stored, so the agent's next edit was
 * addressed against a document eight lines shorter than the one on disk and
 * left a stale tail behind.
 *
 * Two invariants keep that from being possible again:
 *
 *  1. The stored content IS the projection. Line numbers are computed against
 *     `addLineBreaksForAI`-normalized content, so that same normalized string
 *     is what gets written back. Reading a page never reshapes what a write
 *     just stored, because the write already stored the read's shape.
 *  2. The reported count is measured on the stored content, after
 *     normalization, never on an intermediate array. `newLineCount` is by
 *     construction the number a subsequent read returns.
 *
 * The corollary the callers rely on: `oldContent` (diff baseline) is
 * normalized with the *same* function as `newContent` — otherwise a
 * single-line edit diffs as a full-document replacement, because raw HTML and
 * line-broken HTML share almost no lines.
 */

import { addLineBreaksForAI } from './line-breaks';

/**
 * Thrown for a line range the document cannot satisfy. Distinct from a generic
 * Error so the HTTP surface can answer 400 with the message rather than 500.
 */
export class LineRangeError extends Error {
  /**
   * `range` — the addressed lines do not exist in the document (400).
   * `stale` — the caller told us how long the document was and was wrong, so
   * the edit is addressed against a version it has not seen (409).
   */
  readonly kind: 'range' | 'stale';

  constructor(message: string, kind: 'range' | 'stale' = 'range') {
    super(message);
    this.name = 'LineRangeError';
    this.kind = kind;
  }
}

export interface LineEditContentParams {
  /** Raw stored page content (may be null). */
  content: string | null | undefined;
  /**
   * True for content with natural line structure (markdown, code) where
   * `addLineBreaksForAI` must NOT be applied; false for HTML documents.
   */
  isRawText: boolean;
  /**
   * Optional staleness guard: the document length the caller believes it is
   * editing. When it disagrees with reality the edit is refused instead of
   * being applied to a document the caller has not seen — the failure mode
   * that left #2463's registry page holding invalid JSON.
   */
  expectedTotalLines?: number;
}

export interface ReplaceLinesParams extends LineEditContentParams {
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** Replacement text; an empty string deletes the range. */
  replacement: string;
}

export interface InsertLinesParams extends LineEditContentParams {
  /** 1-based line number to insert before; clamped to one past the end. */
  startLine: number;
  /** Text to insert. May span multiple lines. */
  insertion: string;
}

export interface DeleteLinesParams extends LineEditContentParams {
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
}

export interface LineEditResult {
  /** Diff baseline, normalized identically to `newContent`. */
  oldContent: string;
  /** Edited content, normalized identically to `oldContent`. This is what callers must store. */
  newContent: string;
  /** Line count of the document before the edit. */
  previousLineCount: number;
  /**
   * Line count of the stored result — measured on `newContent` itself, so it
   * is exactly what the next read of this page returns.
   */
  newLineCount: number;
  /** Number of source lines that were replaced or removed. */
  linesReplaced: number;
  changeType: 'deletion' | 'replacement' | 'insertion';
}

/**
 * The canonical text a page's line numbers are counted against — and, after an
 * edit, the text that gets stored. HTML is line-broken; markdown and code keep
 * their own newlines.
 */
export function canonicalizeForLineEditing(
  content: string | null | undefined,
  isRawText: boolean
): string {
  return isRawText ? (content || '') : addLineBreaksForAI(content || '');
}

/** The canonical line array for a page's content. */
export function projectLines(content: string | null | undefined, isRawText: boolean): string[] {
  return canonicalizeForLineEditing(content, isRawText).split('\n');
}

function assertExpectedTotalLines(actual: number, expected: number | undefined): void {
  if (expected === undefined || expected === actual) return;
  throw new LineRangeError(
    `Document has ${actual} lines, but the edit was addressed against ${expected}. ` +
      `Re-read the page and re-address the edit — applying it now would edit lines you have not seen.`,
    'stale'
  );
}

/**
 * Assemble and canonicalize an edited document. The join-then-normalize order
 * matters: normalizing once, here, is what makes the returned count agree with
 * the next read. The MCP route used to normalize a second time over content
 * that already had newlines and then report a count taken before that pass.
 */
function finish(
  oldContent: string,
  newLines: string[],
  isRawText: boolean,
  previousLineCount: number,
  linesReplaced: number,
  changeType: LineEditResult['changeType']
): LineEditResult {
  const newContent = canonicalizeForLineEditing(newLines.join('\n'), isRawText);
  return {
    oldContent,
    newContent,
    previousLineCount,
    newLineCount: newContent.split('\n').length,
    linesReplaced,
    changeType,
  };
}

/**
 * Replace an inclusive 1-based line range with `replacement`, returning both
 * the normalized baseline and result so they can be diffed line-for-line.
 *
 * @throws {LineRangeError} if the line range is out of bounds or inverted.
 */
export function replaceLines(params: ReplaceLinesParams): LineEditResult {
  const { content, startLine, endLine, replacement, isRawText, expectedTotalLines } = params;

  const oldContent = canonicalizeForLineEditing(content, isRawText);
  const lines = oldContent.split('\n');
  assertExpectedTotalLines(lines.length, expectedTotalLines);

  if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
    throw new LineRangeError(
      `Invalid line range: ${startLine}-${endLine}. Document has ${lines.length} lines.`
    );
  }

  const isDeletion = replacement.length === 0;
  // Split on newlines: a multi-line replacement is multi-line in the result
  // too. Pushing it as a single array element still JOINED correctly, so the
  // stored document was right — but every count taken from the array was
  // short by (payload lines - 1), which is the `newLineCount: 9` an agent was
  // told for a 91-line payload in #2463.
  const replacementSegment = isDeletion ? [] : replacement.split('\n');
  const newLines = [
    ...lines.slice(0, startLine - 1),
    ...replacementSegment,
    ...lines.slice(endLine),
  ];

  return finish(
    oldContent,
    newLines,
    isRawText,
    lines.length,
    endLine - startLine + 1,
    isDeletion ? 'deletion' : 'replacement'
  );
}

/**
 * Insert `insertion` before 1-based `startLine`, clamped to one past the last
 * line (so inserting "at the end" is expressible without knowing the length).
 */
export function insertLines(params: InsertLinesParams): LineEditResult {
  const { content, startLine, insertion, isRawText, expectedTotalLines } = params;

  const oldContent = canonicalizeForLineEditing(content, isRawText);
  const lines = oldContent.split('\n');
  assertExpectedTotalLines(lines.length, expectedTotalLines);

  if (startLine < 1) {
    throw new LineRangeError(`Invalid insert position: ${startLine}. Line numbers are 1-based.`);
  }

  const insertIndex = Math.min(startLine - 1, lines.length);
  const newLines = [
    ...lines.slice(0, insertIndex),
    ...insertion.split('\n'),
    ...lines.slice(insertIndex),
  ];

  return finish(oldContent, newLines, isRawText, lines.length, 0, 'insertion');
}

/**
 * Delete an inclusive 1-based line range.
 *
 * @throws {LineRangeError} if the line range is out of bounds or inverted.
 */
export function deleteLines(params: DeleteLinesParams): LineEditResult {
  const { content, startLine, endLine, isRawText, expectedTotalLines } = params;

  const oldContent = canonicalizeForLineEditing(content, isRawText);
  const lines = oldContent.split('\n');
  assertExpectedTotalLines(lines.length, expectedTotalLines);

  if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
    throw new LineRangeError(
      `Invalid line range: ${startLine}-${endLine}. Document has ${lines.length} lines.`
    );
  }

  const newLines = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)];

  return finish(oldContent, newLines, isRawText, lines.length, endLine - startLine + 1, 'deletion');
}
