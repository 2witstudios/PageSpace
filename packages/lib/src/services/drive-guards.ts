/**
 * Drive Guards - Pure decision functions for the Home drive feature.
 *
 * The Home drive is a protected personal drive (drives.kind === 'HOME') that
 * anchors personalization and memory content. It is an exfiltration boundary:
 * it cannot be renamed, trashed, shared, or published. Every route, service,
 * and AI tool that enforces these rules imports its verdicts — and its
 * user-facing error messages — from this module, never re-deriving them.
 *
 * This module is intentionally pure: no DB, no IO, no imports.
 */

export const HOME_DRIVE_NAME = 'Home';

/**
 * Drive names users may not take for themselves, compared after trimming and
 * lowercasing. 'personal' predates the Home drive; 'home' is reserved for it.
 */
export const RESERVED_DRIVE_NAMES = ['personal', 'home'] as const;

export type HomeDriveAction =
  | 'rename'
  | 'trash'
  | 'restore'
  | 'invite'
  | 'share'
  | 'publish'
  | 'transfer';

export function isReservedDriveName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (RESERVED_DRIVE_NAMES as readonly string[]).includes(normalized);
}

/**
 * A drive is Home only when kind === 'HOME'. Missing/null/other kinds are
 * STANDARD — stale client caches persist drives without a kind field, and
 * they must never be treated as protected.
 */
export function isHomeDrive(drive: { kind?: string | null }): boolean {
  return drive.kind === 'HOME';
}

const HOME_DRIVE_ACTION_ERRORS: Record<HomeDriveAction, string> = {
  rename: 'Your Home drive cannot be renamed.',
  trash: 'Your Home drive cannot be moved to trash or deleted.',
  // Home can never be trashed, so restore is unreachable in practice; the
  // guard (and its own copy) exists for defense in depth.
  restore: 'Your Home drive is never in trash, so it cannot be restored.',
  invite: 'Your Home drive is private and cannot be shared.',
  share: 'Your Home drive is private and cannot be shared.',
  publish: 'Pages in your Home drive cannot be published.',
  // Unreachable today (Home never has admin members to transfer to) — kept as
  // defense in depth on the ownership-transfer path.
  transfer: 'Your Home drive cannot be transferred to another user.',
};

/**
 * Returns the canonical user-facing error for a blocked action on a Home
 * drive, or null when the action is allowed (i.e. the drive is not Home).
 */
export function homeDriveActionError(
  drive: { kind?: string | null },
  action: HomeDriveAction
): string | null {
  if (!isHomeDrive(drive)) return null;
  return HOME_DRIVE_ACTION_ERRORS[action];
}

/**
 * Resolves a slug that does not collide with the caller-supplied existing
 * slugs: the bare base if free, otherwise the base with the lowest free
 * numeric suffix starting at 2 (home, home-2, home-3, ...).
 *
 * Pure by design — callers (provisioning, backfill) fetch the owner's slugs
 * and pass them in.
 */
export function resolveUniqueSlug(existingSlugs: string[], base: string): string {
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}
