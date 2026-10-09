/**
 * Compute the SHA-256 content hash of a file in the browser via WebCrypto.
 * Standalone and pure — bytes in, lowercase 64-char hex digest out. No React,
 * no state, no side effects. Content-addressed: the hash depends only on the
 * bytes, never on the filename or metadata.
 */
export async function computeContentHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
