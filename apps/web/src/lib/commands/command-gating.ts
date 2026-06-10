/**
 * Exposure gating for Universal Commands (spec §0).
 *
 * At launch the `/` trigger, picker, and all command authoring/invoking UI
 * render only for admin accounts — the same `role === 'admin'` check the
 * settings hub uses. For everyone else `/` types as a literal character.
 * Widening the gate later is a change to this predicate only.
 */
export function canUseCommands(
  user: { role?: string | null } | null | undefined
): boolean {
  return user?.role === 'admin';
}

/**
 * Drive authoring gate (spec §4.1) — same predicate as the drive settings
 * hub. Distinct from the exposure gate above: this is about who may
 * create/edit/delete a drive's commands, not who can see the feature.
 */
export function canManageDriveCommands(
  drive: { isOwned?: boolean; role?: string | null } | null | undefined
): boolean {
  return Boolean(drive && (drive.isOwned || drive.role === 'ADMIN'));
}
