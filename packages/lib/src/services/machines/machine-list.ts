/**
 * "Every Machine in this drive" — the Development surface's aggregated tree is
 * a list of Machine pages, and nothing else listed one. The existing machine
 * services all address ONE machine by id, and the global-machine-config
 * repository finds only THE global machine, so this is the one net-new query
 * the surface needs.
 *
 * Pure + DI'd like the rest of `services/machines`: the drive scan and the
 * permission check are both injected, so the interesting part (a page the actor
 * cannot view must not leak out of the drive scan) is testable without a DB.
 */

export interface MachinePageSummary {
  id: string;
  title: string;
  /** ISO-8601. Callers order by it or show it; the service itself preserves the scan's order. */
  updatedAt: string;
}

export interface MachineListDeps {
  /** Every non-trashed MACHINE-type page in the drive, in the order it should be presented. */
  findMachinePagesInDrive: (driveId: string) => Promise<MachinePageSummary[]>;
  canUserViewPage: (userId: string, pageId: string) => Promise<boolean>;
}

/**
 * The Machine pages in `driveId` that `actorUserId` may view, in scan order.
 *
 * The drive scan is a raw `type = MACHINE` query, so it is NOT permission-aware
 * on its own — a page-level grant can withhold an individual Machine from a
 * drive member. Every candidate is therefore re-checked against
 * `canUserViewPage` here, which is the same view-level gate every other machine
 * route applies before serving a machine's projects/branches/sessions.
 */
export async function listMachinesInDrive(
  deps: MachineListDeps,
  actorUserId: string,
  driveId: string,
): Promise<MachinePageSummary[]> {
  const candidates = await deps.findMachinePagesInDrive(driveId);
  const visibility = await Promise.all(
    candidates.map((machine) => deps.canUserViewPage(actorUserId, machine.id)),
  );
  return candidates.filter((_, index) => visibility[index]);
}
