/**
 * Production wiring for the shared Machine access checks
 * (`@pagespace/lib/services/machines/machine-access`) — binds the pure
 * view/edit decision to the real DB page lookup and the real permission
 * functions. New Phase 1 routes (files/diff/settings) should import
 * `canViewMachine`/`canEditMachine` from here instead of re-deriving the
 * check inline, the way `machine-branches-runtime.ts` and
 * `agent-terminals-runtime.ts` each already do for their own operations —
 * those two are left untouched, this is for new code going forward.
 *
 * Takes the actor's user id directly — mirroring `canAccessMachine`/
 * `canViewMachine` in `./machine-branches-runtime`, which the same
 * `MachineAccessDeps` pattern was extracted from — rather than a full
 * `MachineActorContext`, so a caller never has to pay for
 * `resolveMachineActorContext`'s DB round trip just to gate access.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import {
  canViewMachine as canViewMachineCore,
  canEditMachine as canEditMachineCore,
  type MachineAccessDeps,
} from '@pagespace/lib/services/machines/machine-access';
import type { PageType } from '@pagespace/lib/utils/enums';

function buildMachineAccessDeps(): MachineAccessDeps {
  return {
    findPageType: async (machineId) => {
      const page = await db.query.pages.findFirst({ where: eq(pages.id, machineId), columns: { type: true } });
      return (page?.type as PageType | undefined) ?? null;
    },
    canUserViewPage,
    canUserEditPage,
  };
}

/** View-level access (e.g. read files/diff/settings) for a Machine page. */
export async function canViewMachine(actorUserId: string, machineId: string): Promise<boolean> {
  return canViewMachineCore(buildMachineAccessDeps(), actorUserId, machineId);
}

/** Edit-level access (e.g. mutate settings, write files) for a Machine page — re-checked on every call, never cached. */
export async function canEditMachine(actorUserId: string, machineId: string): Promise<boolean> {
  return canEditMachineCore(buildMachineAccessDeps(), actorUserId, machineId);
}
