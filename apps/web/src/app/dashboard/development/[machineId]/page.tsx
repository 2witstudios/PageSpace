/**
 * The GLOBAL Development surface's detail route — the driveless twin of
 * `[driveId]/development/[machineId]/page.tsx`.
 *
 * Renders NOTHING on purpose, for the same reason as its drive-scoped sibling:
 * the machine is drawn by `MachineKeepAliveHost` in this segment's layout,
 * which keeps recently-visited machines mounted across navigation (CSS-hiding
 * the inactive ones) so their terminals survive. Mounting a `MachineView` here
 * as well would create a second, competing terminal subtree for the same
 * machine.
 *
 * The route still exists to make a machine bookmarkable: the URL is what the
 * layout reads to decide which machine is active.
 */
export default function GlobalDevelopmentMachinePage() {
  return null;
}
