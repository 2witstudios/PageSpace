/**
 * Conflict-equality comparison for rollback.
 *
 * Pure, effect-free deep value comparison used by conflict detection. The
 * semantics here are a deliberate contract, not an accident of `===`:
 *
 *  - NaN equals NaN (Object.is-style). Under `===`, a NaN-valued field would
 *    read as permanently conflicting; that is a bug, so NaN compares equal to
 *    itself. Signed zero is intentionally left on `===` semantics (0 === -0)
 *    so numeric zero never spuriously conflicts.
 *  - A Date and a string are compared by instant, not by serialized form, so
 *    a stored ISO string and a live Date of the same moment are equal even
 *    when their string representations differ. Two unparseable instants
 *    (NaN ms) are equal under the same NaN-equals-NaN rule.
 *  - Object key presence is significant: an explicit `undefined` field is not
 *    equal to a missing key (the key-count guard rejects it).
 */

/** Convert a Date or date-like value to milliseconds since epoch (NaN if unparseable). */
function toInstantMs(value: Date | unknown): number {
  return value instanceof Date ? value.getTime() : new Date(value as string).getTime();
}

/**
 * Deep value comparison implementing the documented conflict-equality contract:
 * NaN equals NaN, Date/string compared by instant, and object key presence is
 * significant. Used by getConflictFields and isNoOpChange.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  // Fast path: strictly-equal references and primitives (also covers 0 === -0).
  if (a === b) return true;

  // Null/undefined: only equal to themselves, and === already handled that.
  if (a == null || b == null) return a === b;

  // Dates compared by instant. Two unparseable instants (NaN ms) are equal under
  // the same NaN-equals-NaN contract as the mixed Date/string branch below.
  if (a instanceof Date && b instanceof Date) {
    const aMs = a.getTime();
    const bMs = b.getTime();
    return aMs === bMs || (Number.isNaN(aMs) && Number.isNaN(bMs));
  }
  if (a instanceof Date || b instanceof Date) {
    const aMs = toInstantMs(a);
    const bMs = toInstantMs(b);
    // Two unparseable instants are equal under the NaN-equals-NaN contract.
    if (Number.isNaN(aMs) && Number.isNaN(bMs)) return true;
    return aMs === bMs;
  }

  // Arrays: element-wise.
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  // Plain objects: same own-keys with equal values (key presence is significant).
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }

  // Primitives: NaN is Object.is-equal to itself so a NaN field cannot
  // perpetually conflict; everything else falls back to strict equality.
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return a === b;
}
