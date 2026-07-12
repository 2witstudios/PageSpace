/**
 * The Development surface's URL shape: `/dashboard/{driveId}/development[/{machineId}]`.
 *
 * Both the sidebar (to highlight the selected machine) and the surface's layout
 * (to tell the keep-alive host which machine is active) need the selected
 * machine id, so the parse lives here rather than being written twice.
 */
export function parseSelectedMachineId(pathname: string, driveId: string | undefined): string | null {
  if (!driveId) return null;
  const prefix = `/dashboard/${driveId}/development/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split('/')[0] || null;
}
