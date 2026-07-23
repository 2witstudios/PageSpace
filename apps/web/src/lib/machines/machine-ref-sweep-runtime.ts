/**
 * Production wiring for the dangling-MachineRef sweep (issue #2156).
 *
 * Binds the provider-agnostic reconcile (`@pagespace/lib/services/machines/
 * machine-ref-sweep` — read its module doc first; it explains WHY this is a
 * reconcile and not a guard on each delete path) to the real DB.
 *
 * Three seams carry the weight:
 *
 * `findExistingPageIds` asks only whether a `pages` row EXISTS. There is
 * deliberately NO `isTrashed` filter: a trashed Machine is restorable, and
 * dropping its refs would silently destroy a setting the user can still get
 * back. Only a HARD-deleted machine is dead. (Same line the orphan reconciler
 * draws before it kills a Sprite.)
 *
 * `writeAgentConfig` goes through the canonical `applyPageMutation` — same call
 * `createDbMachineRefScrub` makes — so each rewritten agent gets its revision
 * bump, page version and activity entry, and so the write is a compare-and-swap
 * on the revision we read: an agent whose owner saved a new machine list while
 * the sweep was running loses the CAS and is simply retried on the next run,
 * rather than being clobbered with our stale array. The ACTOR is the agent
 * page's drive owner — a real user, because activity/audit rows are FK'd to
 * `users` and this repo has no system-user convention. A drive with no owner row
 * is left alone (reported as a failure) instead of being written under a
 * fabricated actor.
 *
 * `writeGlobalConfig` has no revision to CAS on — `global_assistant_config` is
 * not a page. So it re-reads the row inside a transaction under `SELECT … FOR
 * UPDATE` (the lock `getOrCreateOwnMachinePageId` already uses on this table)
 * and re-applies the SAME dead set to whatever it finds. A concurrent settings
 * save is therefore either serialized behind us or observed by us; either way
 * the machine the user just added survives and only the dead refs go.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { globalAssistantConfig } from '@pagespace/db/schema/integrations';
import {
  planMachineRefRewrite,
  sweepMachineRefs,
  type MachineRefHolder,
  type MachineRefWrite,
  type SweepMachineRefsDeps,
  type SweepMachineRefsResult,
} from '@pagespace/lib/services/machines/machine-ref-sweep';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation } from '@/services/api/page-mutation-service';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface AgentConfigRow extends MachineRefHolder {
  pageId: string;
  revision: number;
  driveId: string;
}

interface GlobalConfigRow extends MachineRefHolder {
  userId: string;
}

/**
 * Rows whose blob holds at least one `{kind:'existing'}` element — the only
 * shape a dangling ref can take. Written as a jsonb containment so it is
 * index-friendly AND total: containment on a non-array blob is simply false,
 * where `jsonb_array_length` would raise.
 */
const HOLDS_AN_EXISTING_REF = sql`@> '[{"kind":"existing"}]'::jsonb`;

function holdsAnyOf(column: unknown, candidateMachineIds: readonly string[]) {
  // `jsonb_array_elements` RAISES on a non-array blob, so a malformed row would
  // abort the whole listing — and Postgres does NOT guarantee left-to-right `AND`
  // evaluation, so a separate `jsonb_typeof(...) = 'array' AND EXISTS(...)`
  // guard is not reliable: the planner may evaluate the EXISTS branch first. The
  // guard is instead baked directly into `jsonb_array_elements`'s own argument
  // via CASE, which Postgres must evaluate before the call can run.
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END
    ) AS elem
    WHERE elem->>'kind' = 'existing' AND elem->>'machineId' = ANY(${[...candidateMachineIds]}::text[])
  )`;
}

function machinesFilter(column: unknown, candidateMachineIds?: readonly string[]) {
  return candidateMachineIds
    ? holdsAnyOf(column, candidateMachineIds)
    : sql`${column} ${HOLDS_AN_EXISTING_REF}`;
}

/**
 * The actor to attribute a system rewrite of an agent page to: that page's
 * drive owner. Cached per sweep run — a purge typically hits many agents in the
 * same drive.
 */
function createDriveOwnerLookup() {
  const cache = new Map<string, string | null>();
  return async function lookupDriveOwner(driveId: string): Promise<string | null> {
    const cached = cache.get(driveId);
    if (cached !== undefined) return cached;
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: { ownerId: true },
    });
    const ownerId = drive?.ownerId ?? null;
    cache.set(driveId, ownerId);
    return ownerId;
  };
}

function createDeps(candidateMachineIds?: readonly string[]): SweepMachineRefsDeps<AgentConfigRow, GlobalConfigRow> {
  const lookupDriveOwner = createDriveOwnerLookup();

  return {
    candidateMachineIds,

    listAgentConfigs: (ids) =>
      db
        .select({
          pageId: pages.id,
          revision: pages.revision,
          driveId: pages.driveId,
          entries: pages.machines,
          machineAccess: pages.machineAccess,
        })
        .from(pages)
        .where(and(eq(pages.type, 'AI_CHAT'), machinesFilter(pages.machines, ids))),

    listGlobalConfigs: (ids) =>
      db
        .select({
          userId: globalAssistantConfig.userId,
          entries: globalAssistantConfig.machines,
          machineAccess: globalAssistantConfig.machineAccess,
        })
        .from(globalAssistantConfig)
        .where(machinesFilter(globalAssistantConfig.machines, ids)),

    findExistingPageIds: async (ids) => {
      // No isTrashed filter — see the module doc. A trashed Machine is alive.
      const rows = await db.select({ id: pages.id }).from(pages).where(inArray(pages.id, [...ids]));
      return rows.map((row) => row.id);
    },

    writeAgentConfig: async ({ config, machines, machineAccess, deadMachineIds }: MachineRefWrite<AgentConfigRow>) => {
      const actorUserId = await lookupDriveOwner(config.driveId);
      if (!actorUserId) {
        // No real user to attribute the mutation to. Throwing reports it as a
        // failure and leaves the blob for a later run, which is strictly better
        // than writing page history under an invented actor.
        throw new Error(`No drive owner for agent page ${config.pageId}; cannot attribute machine-ref sweep`);
      }
      const actorInfo = await getActorInfo(actorUserId);
      // machineAccess is only written when it actually changed, so an unrelated
      // toggle never shows up in this page's history.
      const accessChanged = machineAccess !== config.machineAccess;
      await applyPageMutation({
        pageId: config.pageId,
        operation: 'agent_config_update',
        updates: accessChanged ? { machines, machineAccess } : { machines },
        updatedFields: accessChanged ? ['machines', 'machineAccess'] : ['machines'],
        expectedRevision: config.revision,
        context: {
          userId: actorUserId,
          actorEmail: actorInfo?.actorEmail,
          actorDisplayName: actorInfo?.actorDisplayName ?? undefined,
          changeGroupType: 'system',
          resourceType: 'agent',
          metadata: { cascade: 'machine_purge', machineIds: [...deadMachineIds] },
        },
      });
      return true;
    },

    writeGlobalConfig: async ({ config, deadMachineIds }: MachineRefWrite<GlobalConfigRow>) =>
      db.transaction(async (tx: TransactionType) => {
        const [locked] = await tx
          .select({ machines: globalAssistantConfig.machines, machineAccess: globalAssistantConfig.machineAccess })
          .from(globalAssistantConfig)
          .where(eq(globalAssistantConfig.userId, config.userId))
          .for('update');
        // The row can have been deleted (account erasure) or already repaired by
        // a concurrent run between the listing and the lock.
        if (!locked) return false;

        const plan = planMachineRefRewrite({
          entries: locked.machines,
          machineAccess: locked.machineAccess,
          deadMachineIds,
        });
        if (!plan.changed) return false;

        await tx
          .update(globalAssistantConfig)
          .set({ machines: plan.machines, machineAccess: plan.machineAccess })
          .where(eq(globalAssistantConfig.userId, config.userId));
        return true;
      }),
  };
}

/**
 * Drop every MachineRef pointing at a machine page that no longer exists.
 *
 * `candidateMachineIds` scopes the run to machines a caller just hard-deleted
 * (cheap, immediate healing on the interactive delete routes); omitting it
 * sweeps everything, which is the cron backstop for the paths no call site can
 * cover — account erasure, drive cascades, manual DB surgery.
 */
export function sweepDanglingMachineRefs(
  candidateMachineIds?: readonly string[],
): Promise<SweepMachineRefsResult> {
  return sweepMachineRefs(createDeps(candidateMachineIds));
}

/**
 * The MACHINE page ids in a page subtree, root included — collected BEFORE a
 * hard delete, because afterwards the rows are gone and the set is
 * unrecoverable. Mirrors the recursive CTE the same route already uses to
 * snapshot its files.
 */
export async function collectMachinePageIdsInSubtree(rootPageId: string): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, type FROM pages WHERE id = ${rootPageId}
      UNION ALL
      SELECT p.id, p.type FROM pages p JOIN subtree s ON p."parentId" = s.id
    )
    SELECT id FROM subtree WHERE type = 'MACHINE'
  `);
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

/** Every MACHINE page id in a drive — the same snapshot, for a permanent drive delete. */
export async function collectMachinePageIdsInDrive(driveId: string): Promise<string[]> {
  const rows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.driveId, driveId), eq(pages.type, 'MACHINE')));
  return rows.map((row) => row.id);
}
