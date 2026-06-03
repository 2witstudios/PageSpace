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
