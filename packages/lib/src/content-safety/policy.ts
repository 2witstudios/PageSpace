/**
 * Content-safety policy — pure functions and types, no I/O.
 *
 * The blocklist is keyed by content hash because storage is content-addressed in
 * one global namespace (`files/<hash>/original`): the hash IS the identity of the
 * bytes for every tenant. Keeping these decisions pure keeps them unit-testable
 * and reusable by the takedown (PR 2), reporting (PR 3) and scanning (PR 4) code.
 */

import type { ContentBlockCategory } from '@pagespace/db/schema/content-safety';
import { validateContentHash } from '../services/upload-validation';

/**
 * The only thing a refused uploader is told. It deliberately gives no reason:
 * confirming that a specific file is on a blocklist tells an abuser exactly
 * which bytes to alter.
 */
export const CONTENT_BLOCKED_MESSAGE = "This file can't be uploaded";

/** An ordinary client error — indistinguishable in kind from other upload refusals. */
export const CONTENT_BLOCKED_STATUS = 422;

/**
 * Canonical form of a content hash: trimmed, lowercase sha256 hex. Returns null
 * for anything that isn't one, so a caller can't look up (or block) a value that
 * could never match a stored object. Canonicalization is the upload routes' own
 * `validateContentHash`, so the blocklist key can never drift from the storage key.
 */
export function normalizeContentHash(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const result = validateContentHash(input.trim());
  return result.ok ? result.value : null;
}

/** Normalize a batch: invalid entries dropped, duplicates collapsed, order kept. */
export function normalizeContentHashes(inputs: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    const hash = normalizeContentHash(input);
    if (hash) seen.add(hash);
  }
  return [...seen];
}

/**
 * Whether a takedown in this category removes the bytes for EVERY tenant.
 * CSAM and malware are illegal or harmful wherever they sit. Other categories
 * depend on who is using the file and how, so they stay scoped to the reported
 * page — an identical file in another tenant's drive is left alone.
 */
export function requiresGlobalPurge(category: ContentBlockCategory): boolean {
  switch (category) {
    case 'csam':
    case 'malware':
      return true;
    case 'illegal_other':
    case 'policy':
      return false;
  }
}

/**
 * Thrown by server-side writers when the bytes are on the blocklist. `message`
 * is the neutral user-facing text; `contentHash` is for logs and case tooling
 * and must not be shown to the uploader.
 */
export class ContentBlockedError extends Error {
  readonly contentHash: string;

  constructor(contentHash: string) {
    super(CONTENT_BLOCKED_MESSAGE);
    this.name = 'ContentBlockedError';
    this.contentHash = contentHash;
  }
}
