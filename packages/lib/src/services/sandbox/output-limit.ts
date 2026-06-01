/**
 * Output truncation for sandbox stdout/stderr/file reads (pure).
 *
 * Untrusted code can emit unbounded output; the policy's `maxOutputBytes` caps
 * what we retain and render in the chat tool-call UI. Truncation is byte-bounded
 * (not character-bounded) so a multi-megabyte stream can never blow the cap via
 * wide characters. A partial multi-byte sequence at the cut is decoded
 * leniently (replacement char) rather than thrown — the output is untrusted log
 * data, so a clean lossy cut is correct.
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
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(cut);
  return { text: decoded, truncated: true, originalBytes };
}
