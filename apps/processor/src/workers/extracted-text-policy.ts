/**
 * Pure policy for handling extracted document text (GDPR #973).
 *
 * Extracted text contains document PII. The ingest pipeline always persists it
 * to the database (for search) via the worker's return value; the object-store
 * cache copy is redundant and must never be written in plaintext. We therefore
 * only persist the cache copy when it can be encrypted at rest.
 *
 * No I/O, no env — the caller passes in whether an encryption key is available.
 */

/** Strip null bytes (invalid UTF-8) and trim — the canonical extracted-text cleanup. */
export function cleanExtractedText(raw: string): string {
  return raw.replace(/\0/g, '').trim();
}

/**
 * Whether to write the extracted-text cache object. Persist only when an
 * encryption key is configured so PII text is never stored unencrypted.
 */
export function shouldPersistExtractedText({ hasEncryptionKey }: { hasEncryptionKey: boolean }): boolean {
  return hasEncryptionKey;
}
