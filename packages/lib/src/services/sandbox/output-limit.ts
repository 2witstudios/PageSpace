/**
 * Output truncation for sandbox stdout/stderr/file reads (pure).
 *
 * Untrusted code can emit unbounded output; the policy's `maxOutputBytes` caps
 * what we retain and render in the chat tool-call UI. Truncation is byte-bounded
 * (not character-bounded) so a multi-megabyte stream can never blow the cap via
 * wide characters, and the returned text's UTF-8 byte length is a HARD upper
 * bound — never exceeding `maxBytes` even after a partial multi-byte sequence at
 * the cut is decoded leniently (the 3-byte replacement char is trimmed back if
 * it would push the result over). Lossy-but-bounded is correct here: the output
 * is untrusted log data.
 */

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  /** Byte length of the original, pre-truncation text. */
  originalBytes: number;
}

export function truncateToBytes({
  text = '',
  maxBytes,
}: {
  text?: string;
  maxBytes: number;
}): TruncatedOutput {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  // Cut on the byte buffer, then decode leniently so a split multi-byte
  // sequence at the boundary becomes a replacement char instead of throwing.
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let decoded = new TextDecoder('utf-8', { fatal: false }).decode(cut);
  // The replacement char (U+FFFD) is 3 UTF-8 bytes, so a partial sequence at the
  // cut can make the decoded string EXCEED maxBytes (e.g. '😀😀' capped at 2 →
  // '�' is 3 bytes). Drop trailing code points until the byte length fits, so the
  // cap is a hard upper bound (only a handful of iterations: the overflow is the
  // few replacement chars at the tail).
  if (Buffer.byteLength(decoded, 'utf8') > maxBytes) {
    const codePoints = Array.from(decoded);
    while (codePoints.length > 0 && Buffer.byteLength(codePoints.join(''), 'utf8') > maxBytes) {
      codePoints.pop();
    }
    decoded = codePoints.join('');
  }
  return { text: decoded, truncated: true, originalBytes };
}

export interface LineWindow {
  /** The selected lines, rejoined with '\n'. */
  text: string;
  /** 1-based bounds of what was ACTUALLY returned. `firstLine > lastLine` iff empty. */
  firstLine: number;
  lastLine: number;
  totalLines: number;
  /** True when the window does not cover the whole file. */
  windowed: boolean;
  /** True when the byte budget, not `limit`, ended the window. */
  bytesCapped: boolean;
  /** True when at least one returned line was itself too long and was elided. */
  lineElided: boolean;
}

/** Appended to a line clipped by `maxLineBytes`, so elision is never silent. */
export const LINE_ELISION_MARKER = ' … [line truncated]';

/**
 * Select a 1-based line window from text, for `readFile`'s offset/limit paging.
 *
 * LINE-addressed rather than byte-addressed on purpose: a byte offset cuts
 * mid-line, and the anchors `editFile` matches on are lines. Paging by line is
 * what makes a partial read RESUMABLE.
 *
 * THE BYTE BUDGET IS APPLIED HERE, NOT AFTERWARDS. Capping the joined text after
 * selecting the window is a correctness bug, not just a tidiness one: the cut
 * lands mid-window while `lastLine` still names the line the window ASKED for,
 * so the caller is told to resume at a line far past where the content actually
 * ended and never sees the lines in between. Deciding inclusion line by line
 * means `lastLine` always describes what was really returned, so
 * `offset: lastLine + 1` is always the correct next call.
 *
 * `maxLineBytes` bounds each line individually. That is what keeps a file with
 * one enormous line navigable: without it such a line consumes (or exceeds) the
 * whole budget, and because addressing is by line there is then no offset that
 * can reach past it.
 *
 * Trailing-newline note: a file ending in '\n' splits to a final '' element,
 * which would report a phantom extra line. It is dropped from the count and
 * restored on output only when the window reaches the end, so round-tripping a
 * full read preserves the terminator.
 *
 * An `offset` past the end is NOT an error: it returns an empty window with the
 * real `totalLines`, so a caller that overshoots learns where the file ended
 * instead of getting a failure it has to interpret.
 */
export function selectLineWindow({
  text,
  offset = 1,
  limit,
  maxBytes = Number.POSITIVE_INFINITY,
  maxLineBytes = Number.POSITIVE_INFINITY,
}: {
  text: string;
  offset?: number;
  limit: number;
  maxBytes?: number;
  maxLineBytes?: number;
}): LineWindow {
  const endsWithNewline = text.endsWith('\n');
  const all = text.split('\n');
  if (endsWithNewline) all.pop();

  const totalLines = all.length;
  // Clamp rather than reject: a 0 or negative offset means "from the start".
  const start = Math.max(1, Math.floor(offset));

  if (start > totalLines) {
    return {
      text: '',
      firstLine: start,
      lastLine: start - 1,
      totalLines,
      windowed: true,
      bytesCapped: false,
      lineElided: false,
    };
  }

  const lastByLimit = Math.min(totalLines, start + Math.max(0, Math.floor(limit)) - 1);
  const selected: string[] = [];
  let usedBytes = 0;
  let lastLine = start - 1;
  let bytesCapped = false;
  let lineElided = false;

  for (let n = start; n <= lastByLimit; n += 1) {
    let line = all[n - 1] ?? '';
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      line = truncateToBytes({ text: line, maxBytes: maxLineBytes }).text + LINE_ELISION_MARKER;
      lineElided = true;
    }
    // +1 for the '\n' that will join this line to the previous one.
    const cost = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    // Always return at least one line: a window that returns nothing and reports
    // no progress would leave the caller unable to advance at all.
    if (selected.length > 0 && usedBytes + cost > maxBytes) {
      bytesCapped = true;
      break;
    }
    selected.push(line);
    usedBytes += cost;
    lastLine = n;
  }

  const reachesEnd = lastLine >= totalLines;
  return {
    text: selected.join('\n') + (reachesEnd && endsWithNewline ? '\n' : ''),
    firstLine: start,
    lastLine,
    totalLines,
    windowed: start > 1 || !reachesEnd,
    bytesCapped,
    lineElided,
  };
}
