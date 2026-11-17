/**
 * Blocklist reads — the thin I/O edge over `content_blocks`.
 *
 * One primary-key lookup per call, no cache: a block must take effect on the
 * very next upload, on every replica.
 *
 * A failed lookup throws. Callers must let it propagate (the upload fails)
 * rather than treat "couldn't check" as "not blocked".
 */

import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { contentBlocks } from '@pagespace/db/schema/content-safety';
import { normalizeContentHashes } from './policy';

/** The subset of `hashes` that is blocked, in canonical (lowercase) form. */
export async function findBlockedHashes(hashes: readonly string[]): Promise<Set<string>> {
  const candidates = normalizeContentHashes(hashes);
  if (candidates.length === 0) return new Set();

  const rows = await db
    .select({ contentHash: contentBlocks.contentHash })
    .from(contentBlocks)
    .where(inArray(contentBlocks.contentHash, candidates));

  return new Set(rows.map((row) => row.contentHash));
}

export async function isHashBlocked(hash: string): Promise<boolean> {
  const blocked = await findBlockedHashes([hash]);
  return blocked.size > 0;
}
