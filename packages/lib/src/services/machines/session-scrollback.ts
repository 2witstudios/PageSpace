/**
 * The pure scrollback-tail core shared by two callers (issue #2205):
 * `apps/realtime/src/terminal/session-io.ts`'s live-answer path (`scrollbackTail`,
 * kept as a thin re-exporting adapter over this module so its existing tests are
 * the regression net for the extraction), and the cold-teardown persist path,
 * which caps the WHOLE ring for storage rather than a reader-chosen line count.
 *
 * Chunk-join → CRLF/CR normalize → drop a trailing empty line → optional
 * last-N-lines → byte-cap dropping WHOLE leading lines (never mid-line) →
 * UTF-8-safe mid-line cut with a `…` marker when even one line outgrows the cap.
 */

/** Per-answer cap: this text is going into a model's context window, not an xterm pane. */
export const MAX_SCROLLBACK_TAIL_BYTES = 16 * 1024;

/**
 * Join raw PTY chunks into lines. A ring holds CHUNKS, not lines — one write
 * routinely carries many lines, and one line routinely arrives split across
 * several writes — so everything is joined before anything is counted. CR/LF
 * (and bare CR) normalize to LF: the consumer is a model reading text, not a
 * terminal emulator rendering one.
 */
export function scrollbackLines(chunks: readonly string[]): string[] {
  const lines = chunks.join('').replace(/\r\n?/g, '\n').split('\n');
  // A ring ending in a newline yields a trailing empty element that is not a
  // line of output — dropping it keeps line counts (and `tailOfLines`'s
  // `limit`) meaning real lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Byte-cap a set of lines, dropping WHOLE leading lines rather than slicing
 * mid-line: a cut in the middle of a line (or worse, a multi-byte character)
 * hands the reader a truncated fragment that looks like real output.
 */
export function capTailBytes(lines: readonly string[]): string {
  let tail = [...lines];
  while (tail.length > 1 && Buffer.byteLength(tail.join('\n'), 'utf8') > MAX_SCROLLBACK_TAIL_BYTES) {
    tail = tail.slice(1);
  }
  const joined = tail.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= MAX_SCROLLBACK_TAIL_BYTES) return joined;

  // One newline-free line wider than the whole cap (a minified bundle, a
  // base64 blob) — there is no line boundary left to drop at, so the cap has
  // to cut mid-line after all: keep the most RECENT bytes (the end is where a
  // long line's news is), on a UTF-8 boundary, and say so with a leading
  // marker so the cut never reads as complete output.
  const bytes = Buffer.from(joined, 'utf8');
  const MARKER = '…';
  let start = bytes.length - MAX_SCROLLBACK_TAIL_BYTES + Buffer.byteLength(MARKER, 'utf8');
  // 0b10xxxxxx marks a UTF-8 continuation byte — step forward off any
  // mid-character cut.
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  return `${MARKER}${bytes.subarray(start).toString('utf8')}`;
}

/**
 * The most recent `limit` lines, byte-capped. `limit <= 0` asks for nothing —
 * the `list_sessions` liveness sweep's shape (a scrollback tail with `limit: 0`).
 */
export function tailOfLines(lines: readonly string[], limit: number): string {
  if (limit <= 0) return '';
  return capTailBytes(lines.slice(-limit));
}
