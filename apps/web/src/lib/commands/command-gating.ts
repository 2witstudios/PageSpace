/**
 * Universal Commands — exposure-gating predicates (spec §0, §4.1).
 *
 * At launch the whole feature is visible only to admin accounts (same check
 * the settings hub uses: `user.role === 'admin'`). Widening the gate later
 * means changing these predicates only.
 */

export interface GateUser {
  role?: string | null;
}

export interface GateDrive {
  isOwned?: boolean;
  role?: string | null;
}

/** Launch gate: command settings surfaces are visible to admin accounts only. */
export function canSeeCommandSettings(user: GateUser | null | undefined): boolean {
  return user?.role === 'admin';
}

/** Drive authoring gate — same predicate as the drive settings hub. */
export function canManageDriveCommands(drive: GateDrive | null | undefined): boolean {
  return Boolean(drive && (drive.isOwned || drive.role === 'ADMIN'));
}
