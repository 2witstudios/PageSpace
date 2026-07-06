/**
 * Ownership predicate for the connected-apps revoke-by-id mutation (Phase 8
 * task k58h61obmc91sn1ndngrsev5). Pure — the caller fetches the row (or
 * `null` if no row matched the id at all) and this just answers the yes/no
 * question, so "not found" and "found but belongs to someone else" collapse
 * to the exact same `false` with no distinguishable path for the route layer
 * to leak as an oracle.
 *
 * @module @pagespace/lib/auth/oauth/grant-ownership
 */

export interface OAuthGrantOwnershipRow {
  userId: string;
}

export function isGrantOwnedByUser<T extends OAuthGrantOwnershipRow>(row: T | null, userId: string): row is T {
  return row !== null && row.userId === userId;
}
