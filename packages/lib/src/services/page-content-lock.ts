/**
 * Per-ref serialisation between writing a content blob and reclaiming it.
 *
 * Content addressing means a writer whose content already exists skips the
 * upload and returns the existing ref. That creates a window: between the
 * writer's existence check and the moment its `contentRef` row commits, the
 * blob has no references, and a reclaimer scanning right then would see an
 * unreferenced object and delete it. The writer would go on to commit a ref
 * pointing at nothing.
 *
 * The age floor alone does not close this. It bounds the age of the *object*,
 * and the object in this scenario is old — it is the *reference* that is new.
 *
 * So both sides take a Postgres advisory lock keyed on the ref: the writer
 * around its storage write, the reclaimer around its stat-and-delete. With
 * those serialised, a writer that returns a ref has always just touched the
 * object, which makes the age floor mean what it claims — "nothing has written
 * this blob recently" — and bridges the remaining gap until the caller's row
 * commits.
 */

/**
 * Namespace for the two-argument advisory lock, so these locks cannot collide
 * with the single-argument keys used elsewhere in the codebase.
 */
export const CONTENT_REF_LOCK_CLASS = 0x50430001;

/**
 * Lock id for a content ref: the leading 32 bits of the hash, as the signed
 * 4-byte integer `pg_advisory_xact_lock` takes.
 *
 * Two different refs can share an id (32 bits of a 256-bit hash). A collision
 * costs one needless wait, never a missed exclusion, so narrowing is safe here
 * in a way it would not be for identity.
 */
export function contentRefLockId(ref: string): number {
  return parseInt(ref.slice(0, 8), 16) | 0;
}
