/**
 * Production wiring for the shared "list a drive's Machines" service
 * (`@pagespace/lib/services/machines/machine-list`) — binds the drive scan to
 * the real `pages` table and the visibility filter to the real permission
 * function, the same way `machine-access-runtime.ts` binds the per-machine
 * view/edit checks.
 */

import { and, asc, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  listMachinesInDrive as listMachinesInDriveCore,
  listMachinesAcrossDrives as listMachinesAcrossDrivesCore,
  type MachineListDeps,
  type GlobalMachineListDeps,
  type MachinePageSummary,
  type DriveMachineGroup,
} from '@pagespace/lib/services/machines/machine-list';

export type { MachinePageSummary, DriveMachineGroup };

function buildMachineListDeps(): MachineListDeps {
  return {
    findMachinePagesInDrive: async (driveId) => {
      const rows = await db.query.pages.findMany({
        // Covered by the pages_drive_id_is_trashed_type_idx index.
        where: and(
          eq(pages.driveId, driveId),
          eq(pages.isTrashed, false),
          eq(pages.type, PageType.MACHINE),
        ),
        columns: { id: true, title: true, updatedAt: true },
        orderBy: [asc(pages.title)],
      });
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    canUserViewPage,
  };
}

function buildGlobalMachineListDeps(): GlobalMachineListDeps {
  return {
    ...buildMachineListDeps(),
    // Same drive universe `GET /api/drives` hands DriveSwitcher — owned,
    // member, or page-permission drives. Not the `tokenScopable` variant,
    // since this is a session-only human surface, not something scoped to an
    // MCP token.
    findAccessibleDrives: async (actorUserId) => {
      const drives = await listAccessibleDrives(actorUserId);
      return drives.map((drive) => ({ id: drive.id, name: drive.name }));
    },
  };
}

/** The Machine pages in `driveId` that the actor may view, ordered by title. */
export async function listDriveMachines(actorUserId: string, driveId: string): Promise<MachinePageSummary[]> {
  return listMachinesInDriveCore(buildMachineListDeps(), actorUserId, driveId);
}

/**
 * The Machine pages the actor may view across every drive they can access,
 * grouped by drive — the Development surface's GLOBAL (driveless) command
 * center. See `listMachinesAcrossDrives` for the guarantees this preserves.
 */
export async function listAllMachines(actorUserId: string): Promise<DriveMachineGroup[]> {
  return listMachinesAcrossDrivesCore(buildGlobalMachineListDeps(), actorUserId);
}
