/**
 * The Development surface's detail route.
 *
 * Renders NOTHING on purpose. The machine is drawn by `MachineKeepAliveHost` in
 * this segment's layout, which keeps recently-visited machines mounted across
 * navigation (CSS-hiding the inactive ones) so their terminals survive. Mounting
 * a `MachineView` here as well would create a second, competing terminal subtree
 * for the same machine — the same reason `CenterPanel` renders nothing for
 * MACHINE pages in the drive view.
 *
 * The route still exists to make a machine bookmarkable: the URL is what the
 * layout reads to decide which machine is active.
 */
export default function DevelopmentMachinePage() {
  return null;
}
