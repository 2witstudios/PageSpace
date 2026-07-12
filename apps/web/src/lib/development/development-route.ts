/**
 * The Development surface's URL shape: `/dashboard/{driveId}/development[/{machineId}]`
 * (drive-scoped) or `/dashboard/development[/{machineId}]` (GLOBAL, no drive
 * in the path).
 *
 * Both the sidebar (to highlight the selected machine) and the surface's layout
 * (to tell the keep-alive host which machine is active) need the selected
 * machine id, so the parse lives here rather than being written twice. Pass
 * `undefined` for `driveId` when parsing the global route.
 */
export function parseSelectedMachineId(pathname: string, driveId: string | undefined): string | null {
  const prefix = driveId ? `/dashboard/${driveId}/development/` : '/dashboard/development/';
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split('/')[0] || null;
}
