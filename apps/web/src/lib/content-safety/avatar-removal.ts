import 'server-only';

import { createHash } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { isS3NotFound, readS3ObjectBounded } from '@/lib/storage/s3-objects';

/**
 * Removing (or hiding) ONE scanned avatar, never whatever the user has now.
 *
 * The backfill decides on bytes it read earlier; the user can upload a new avatar at any moment, and the
 * processor stores it at the same key. So every step is tied to the scanned avatar:
 *
 * 1. The profile image is read first. It carries a per-upload `?t=` version.
 * 2. The stored object is read and must still hash to the scanned bytes; its ETag is kept.
 * 3. The profile image is cleared only if it is still the value read in 1: a replacement's own URL survives.
 * 4. The object is deleted only if its ETag is still the one read in 2 (S3 `If-Match`): a replacement stored
 *    meanwhile survives.
 *
 * A replacement at any point is left stored and visible. Storage that ignores `If-Match` falls back to an
 * unconditional delete of that one key.
 */

export interface AvatarRemovalTarget {
  userId: string;
  key: string;
  contentHash: string;
}

export interface AvatarRemovalStore {
  readProfileImage(userId: string): Promise<string | null>;
  readObject(key: string): Promise<{ bytes: Uint8Array; etag: string | null } | null>;
  /** Clear the image only where it still equals `expected`. True when it was cleared. */
  clearProfileImageIf(userId: string, expected: string): Promise<boolean>;
  /** Delete `key` only if its ETag is still `etag` (any, when null). */
  deleteObjectIf(key: string, etag: string | null): Promise<'deleted' | 'changed' | 'gone'>;
}

/** Largest avatar the processor accepts, plus slack. */
const MAX_AVATAR_BYTES = 6 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Steps 1-3. Null when the stored avatar is no longer the scanned one. `profileChanged`: the profile image moved on
 * since step 1 (a replacement's URL, or one the user set), so it was left as it is.
 */
async function clearIfScanned(target: AvatarRemovalTarget, store: AvatarRemovalStore): Promise<{ etag: string | null; profileChanged: boolean } | null> {
  const image = await store.readProfileImage(target.userId);
  const object = await store.readObject(target.key);
  if (!object || sha256(object.bytes) !== target.contentHash) return null;
  const profileChanged = image !== null && !(await store.clearProfileImageIf(target.userId, image));
  return { etag: object.etag, profileChanged };
}

/** Clear the profile image, then delete the object, of the scanned avatar only. */
export async function removeScannedAvatar(target: AvatarRemovalTarget, store: AvatarRemovalStore = createAvatarRemovalStore()): Promise<'removed' | 'replaced'> {
  const scanned = await clearIfScanned(target, store);
  if (!scanned) return 'replaced';
  // Deleted even if the profile moved on: the object, checked by its ETag, is still the scanned avatar.
  // A failed delete throws after the clear: the object is still listed, and the next tick retries the removal.
  const deleted = await store.deleteObjectIf(target.key, scanned.etag);
  return deleted === 'changed' ? 'replaced' : 'removed';
}

/** Stop showing the scanned avatar (clear its profile image) without deleting it. */
export async function hideScannedAvatar(target: AvatarRemovalTarget, store: AvatarRemovalStore = createAvatarRemovalStore()): Promise<'hidden' | 'replaced'> {
  const scanned = await clearIfScanned(target, store);
  return scanned && !scanned.profileChanged ? 'hidden' : 'replaced';
}

export function createAvatarRemovalStore(): AvatarRemovalStore {
  return {
    async readProfileImage(userId) {
      const [row] = await db.select({ image: users.image }).from(users).where(eq(users.id, userId)).limit(1);
      return row?.image ?? null;
    },
    async readObject(key) {
      let etag: string | null;
      try {
        // The ETag first: if the object is replaced between this HEAD and the read, the bytes read do not hash to
        // the scanned ones (nothing is done), or the delete's If-Match fails (the replacement is kept).
        const head = await getS3Client().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: key }));
        etag = head.ETag ?? null;
      } catch (err) {
        if (isS3NotFound(err)) return null;
        throw err;
      }
      const read = await readS3ObjectBounded(getS3Client(), getS3Bucket(), key, MAX_AVATAR_BYTES, READ_TIMEOUT_MS);
      return read?.complete ? { bytes: read.bytes, etag } : null;
    },
    async clearProfileImageIf(userId, expected) {
      const cleared = await db
        .update(users)
        .set({ image: null })
        .where(and(eq(users.id, userId), eq(users.image, expected)))
        .returning({ id: users.id });
      return cleared.length > 0;
    },
    async deleteObjectIf(key, etag) {
      try {
        await getS3Client().send(new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: key, ...(etag ? { IfMatch: etag } : {}) }));
        return 'deleted';
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (status === 412) return 'changed';
        if (isS3NotFound(err)) return 'gone';
        throw err;
      }
    },
  };
}
