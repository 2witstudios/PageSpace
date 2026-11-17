/**
 * Reads a request body as text, aborting as soon as the byte cap is exceeded
 * instead of buffering the whole stream first — bounds memory use for a
 * caller that omits Content-Length (or uses chunked transfer-encoding).
 * Returns null if the cap is exceeded.
 */
export async function readBodyWithCap(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf-8');
}
