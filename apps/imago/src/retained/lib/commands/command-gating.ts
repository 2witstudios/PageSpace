/**
 * Drive authoring gate (spec §4.1) — same predicate as the drive settings
 * hub. Controls who may create/edit/delete a drive's commands.
 */
export function canManageDriveCommands(
  drive: { isOwned?: boolean; role?: string | null } | null | undefined
): boolean {
  return Boolean(drive && (drive.isOwned || drive.role === 'ADMIN'));
}
