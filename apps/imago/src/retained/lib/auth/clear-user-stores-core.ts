/**
 * Pure decision core for persisted-store cleanup on sign-in.
 *
 * Kept free of any storage access so the branch matrix (no previous user /
 * same user / different user) is exhaustively testable; `clear-user-stores.ts`
 * is the effectful shell.
 */

/** Keys written by live stores — only valid for the user that wrote them. */
export const USER_SPECIFIC_STORAGE_KEYS = [
  'drive-storage',
  'favorites-storage',
  'tabs-storage',
  'ui-store',
  'mcp-settings',
  'pagespace:sidebar:selectedAgentData',
] as const;

/**
 * Key prefixes for per-user values whose full key carries an id (the create-org setup plan is
 * `pagespace.orgSetup.<userId>.<orgId>`). Purged on an identity switch, like the keys above.
 */
export const ORG_SETUP_STORAGE_PREFIX = 'pagespace.orgSetup.';
export const USER_SPECIFIC_STORAGE_PREFIXES = [ORG_SETUP_STORAGE_PREFIX] as const;

/**
 * Keys owned by stores that no longer exist. Purged on every sign-in, not just
 * on an identity switch, so orphaned blobs drain out of browsers belonging to
 * users who never switch accounts.
 *
 * - `open-tabs-storage`: `useOpenTabsStore`, deleted in #2142 (duplicate of
 *   `useTabsStore`/`tabs-storage` with zero production readers).
 */
export const LEGACY_STORAGE_KEYS = ['open-tabs-storage'] as const;

/**
 * Which persisted keys to remove for a sign-in.
 *
 * A falsy `lastUserId` (absent key, or an empty string) means "no previous
 * user on this device" — a first sign-in must not wipe state it just restored.
 */
export function computeKeysToClear(
  lastUserId: string | null,
  newUserId: string,
): readonly string[] {
  return userChanged(lastUserId, newUserId)
    ? [...LEGACY_STORAGE_KEYS, ...USER_SPECIFIC_STORAGE_KEYS]
    : [...LEGACY_STORAGE_KEYS];
}

/** Which persisted key prefixes to purge for a sign-in: every per-user prefix on a switch, none otherwise. */
export function computePrefixesToClear(
  lastUserId: string | null,
  newUserId: string,
): readonly string[] {
  return userChanged(lastUserId, newUserId) ? [...USER_SPECIFIC_STORAGE_PREFIXES] : [];
}

function userChanged(lastUserId: string | null, newUserId: string): boolean {
  return Boolean(lastUserId) && lastUserId !== newUserId;
}
