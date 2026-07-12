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
  /** ISO-8601. Served for callers that want recency (the tree itself orders by title). */
  updatedAt: string;
}

export interface MachineListDeps {
  /** Every non-trashed MACHINE-type page in the drive, in the order it should be presented. */
  findMachinePagesInDrive: (driveId: string) => Promise<MachinePageSummary[]>;
  canUserViewPage: (userId: string, pageId: string) => Promise<boolean>;
}

export interface DriveSummary {
  id: string;
  name: string;
}

export interface DriveMachineGroup {
  driveId: string;
  driveName: string;
  machines: MachinePageSummary[];
}

export interface GlobalMachineListDeps extends MachineListDeps {
  /** Every drive `actorUserId` can access (owned, member, or page-permission), non-trashed. */
  findAccessibleDrives: (actorUserId: string) => Promise<DriveSummary[]>;
}

/**
 * The Machine pages in `driveId` that `actorUserId` may view, in scan order.
 *
 * The drive scan is a raw `type = MACHINE` query, so it is NOT permission-aware
 * on its own — a page-level grant can withhold an individual Machine from a
 * drive member. Every candidate is therefore re-checked against
 * `canUserViewPage` here, which is the same view-level gate every other machine
 * route applies before serving a machine's projects/branches/sessions.
 *
 * That check is per page, so this fans out N permission lookups for N machines.
 * Fine at this scale — the surface is app-admin-only, machines are heavyweight
 * things a drive has a handful of, and an owner/admin short-circuits early. If a
 * drive ever holds enough machines for it to matter, resolve drive membership
 * once and fall back to the per-page check only for the non-owner case.
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

/**
 * The Machine pages `actorUserId` may view, across every drive they can access,
 * grouped by drive — the Development surface's GLOBAL (driveless) command
 * center. Each drive's group runs through the exact same `listMachinesInDrive`
 * a per-drive request would, so the guarantee is identical: an admin who lacks
 * access to a drive never sees it here, and a Machine withheld from them by a
 * page-level grant never appears even within a drive they can otherwise see.
 *
 * A drive with no VISIBLE machines (none exist, or every one is withheld) is
 * dropped from the result rather than returned as an empty group — an empty
 * drive header would just be noise in the aggregated list.
 */
export async function listMachinesAcrossDrives(
  deps: GlobalMachineListDeps,
  actorUserId: string,
): Promise<DriveMachineGroup[]> {
  const drives = await deps.findAccessibleDrives(actorUserId);
  const groups = await Promise.all(
    drives.map(async (drive): Promise<DriveMachineGroup> => ({
      driveId: drive.id,
      driveName: drive.name,
      machines: await listMachinesInDrive(deps, actorUserId, drive.id),
    })),
  );
  return groups.filter((group) => group.machines.length > 0);
}
