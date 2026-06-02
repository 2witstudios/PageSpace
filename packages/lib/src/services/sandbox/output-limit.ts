/**
 * Output truncation for sandbox stdout/stderr/file reads (pure).
 *
 * Untrusted code can emit unbounded output; the policy's `maxOutputBytes` caps
 * what we retain and render in the chat tool-call UI. Truncation is byte-bounded
 * (not character-bounded) so a multi-megabyte stream can never blow the cap via
 * wide characters. The cut is moved BACK to the nearest UTF-8 character boundary
 * so it never lands mid-codepoint: that means the result is a clean prefix with
 * no U+FFFD replacement char — which matters because a replacement char is itself
 * 3 UTF-8 bytes and, emitted at the boundary, could push the returned text back
 * OVER `maxBytes` (e.g. '😀😀' capped at 2 bytes). The returned text is therefore
 * GUARANTEED to be ≤ `maxBytes`.
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
  const buffer = Buffer.from(text, 'utf8');
  const originalBytes = buffer.length;
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes };
  }
  // Walk the cut back off any partial trailing multi-byte sequence so it lands on
  // a UTF-8 character boundary. A continuation byte matches 0b10xxxxxx; backing up
  // past them lands on the lead byte of the split codepoint, which we then exclude
  // — yielding a clean prefix with no replacement char (and so guaranteed ≤ maxBytes).
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true, originalBytes };
}
