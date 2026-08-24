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
  /** 1-based bounds of what was selected. `firstLine > lastLine` iff empty. */
  firstLine: number;
  lastLine: number;
  totalLines: number;
  /** True when the window does not cover the whole file. */
  windowed: boolean;
}

/**
 * Select a 1-based line window from text, for `readFile`'s offset/limit paging.
 *
 * LINE-addressed rather than byte-addressed on purpose: a byte offset cuts
 * mid-line, and the anchors `editFile` matches on are lines. Paging by line is
 * what makes a partial read RESUMABLE — the previous byte-cap behaviour gave a
 * caller no way to name the next chunk.
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
}: {
  text: string;
  offset?: number;
  limit: number;
}): LineWindow {
  const endsWithNewline = text.endsWith('\n');
  const all = text.split('\n');
  if (endsWithNewline) all.pop();

  const totalLines = all.length;
  // Clamp rather than reject: a 0 or negative offset means "from the start".
  const start = Math.max(1, Math.floor(offset));
  const end = Math.min(totalLines, start + Math.max(0, Math.floor(limit)) - 1);

  if (start > totalLines) {
    return { text: '', firstLine: start, lastLine: start - 1, totalLines, windowed: true };
  }

  const selected = all.slice(start - 1, end);
  const reachesEnd = end >= totalLines;
  return {
    text: selected.join('\n') + (reachesEnd && endsWithNewline ? '\n' : ''),
    firstLine: start,
    lastLine: end,
    totalLines,
    windowed: start > 1 || !reachesEnd,
  };
}
