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
import { PageType } from '@pagespace/lib/utils/enums';
import {
  listMachinesInDrive as listMachinesInDriveCore,
  type MachineListDeps,
  type MachinePageSummary,
} from '@pagespace/lib/services/machines/machine-list';

export type { MachinePageSummary };

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

/** The Machine pages in `driveId` that the actor may view, ordered by title. */
export async function listDriveMachines(actorUserId: string, driveId: string): Promise<MachinePageSummary[]> {
  return listMachinesInDriveCore(buildMachineListDeps(), actorUserId, driveId);
}
