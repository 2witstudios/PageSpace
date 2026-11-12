import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { contentStore } from '../server';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * A hash on the content blocklist belongs to its takedown, and only the
 * takedown may delete its objects.
 *
 * A takedown preserves a copy before it deletes anything, and for some
 * categories it must wait (no evidence storage configured yet) with the private
 * original as the ONLY copy. Every other deleter in this service — the orphan
 * reaper's delete route, and the "reject this upload" deletes on a failed
 * verification — would destroy that copy. They all come through here.
 *
 * A failed blocklist lookup throws: "couldn't check" is never "not blocked".
 */
export async function isHeldForTakedown(contentHash: string): Promise<boolean> {
  return isHashBlocked(contentHash);
}

/** Delete a rejected upload's original, unless the hash is held for a takedown. Returns whether it deleted. */
export async function deleteOriginalUnlessHeld(contentHash: string): Promise<boolean> {
  if (await isHeldForTakedown(contentHash)) {
    loggers.security.warn('Skipped deleting an object held for a content takedown');
    return false;
  }
  return contentStore.deleteOriginal(contentHash);
}
