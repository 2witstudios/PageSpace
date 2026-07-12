/**
 * The Development surface's URL shape: `/dashboard/{driveId}/development[/{machineId}]`
 * (drive-scoped) or `/dashboard/development[/{machineId}]` (GLOBAL, no drive
 * in the path). The one place both directions of that shape — parsing a
 * machine id back out of a pathname, and building a machine's href — are
 * expressed, so the two can't drift apart. Pass `undefined` for `driveId` for
 * the global route in either direction.
 */
function developmentBasePath(driveId: string | undefined): string {
  return driveId ? `/dashboard/${driveId}/development` : '/dashboard/development';
}

/**
 * Both the sidebar (to highlight the selected machine) and the surface's layout
 * (to tell the keep-alive host which machine is active) need the selected
 * machine id, so the parse lives here rather than being written twice.
 */
export function parseSelectedMachineId(pathname: string, driveId: string | undefined): string | null {
  const prefix = `${developmentBasePath(driveId)}/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split('/')[0] || null;
}

/**
 * A machine's detail URL. In global mode this deliberately stays under
 * `/dashboard/development/{machineId}` — NOT `/dashboard/{driveId}/development/{machineId}`
 * even though the drive is known — because crossing into the drive-scoped
 * route tree would remount the global layout's keep-alive host, tearing down
 * every terminal it's keeping warm across every other drive.
 */
export function buildMachineHref(driveId: string | undefined, machineId: string): string {
  return `${developmentBasePath(driveId)}/${machineId}`;
}
