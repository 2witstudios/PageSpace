/**
 * Reads a request body, aborting as soon as the byte cap is exceeded instead of
 * buffering the whole stream first — bounds memory use for a caller that omits
 * Content-Length (or uses chunked transfer-encoding). Returns null if the cap
 * is exceeded; a request with no body reads as empty.
 */
export async function readBytesWithCap(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Started, not awaited: the caller answers at once, whether or not the stream's cleanup succeeds.
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  // A view over the joined buffer, not a second copy of it.
  const joined = Buffer.concat(chunks);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

/** `readBytesWithCap`, decoded as UTF-8 text. */
export async function readBodyWithCap(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesWithCap(request, maxBytes);
  return bytes === null ? null : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8');
}
