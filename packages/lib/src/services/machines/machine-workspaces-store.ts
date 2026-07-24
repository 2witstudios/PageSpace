/**
 * Machine Workspaces store (IO, dependency-injected).
 *
 * DB-backed CRUD for `machine_workspaces` (the durable, shared record of a
 * Machine's named pane-grid workspaces — `layout` is a rolling-deploy shim
 * post-#2202, see `machine-panes-store.ts` for the relational source of
 * truth). Kept separate from the orchestration layer so it's testable
 * against an in-memory fake without a real database, same split as
 * `machine-projects-store.ts`.
 */

import type { WorkspaceLayoutDTO } from '@pagespace/db/schema/machine-workspaces';
import { isUniqueViolation } from '../subdomain-allocation';

export interface MachineWorkspaceRecord {
  id: string;
  ownerId: string;
  machineId: string;
  scope: 'machine' | 'project' | 'branch';
  projectName: string | null;
  branchName: string | null;
  name: string;
  layout: WorkspaceLayoutDTO;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineWorkspaceInput {
  /** Client-minted — see machine-workspaces-runtime.ts / workspace-reducer.ts's `sessionWorkspaceId`. */
  id: string;
  ownerId: string;
  machineId: string;
  scope: 'machine' | 'project' | 'branch';
  projectName: string | null;
  branchName: string | null;
  name: string;
  layout: WorkspaceLayoutDTO;
  now: Date;
}

export interface MachineWorkspaceStore {
  list(machineId: string): Promise<MachineWorkspaceRecord[]>;
  findById(machineId: string, id: string): Promise<MachineWorkspaceRecord | null>;
  /** Upsert-by-id: first writer wins. Returns `created: false` (with the EXISTING row,
   * never the caller's payload) when another caller already inserted this id. */
  insertIfAbsent(input: NewMachineWorkspaceInput): Promise<{ created: boolean; row: MachineWorkspaceRecord }>;
  /** Applies whichever of `name`/`layout` is provided. `null` if no row matched. */
  update(
    machineId: string,
    id: string,
    patch: { name?: string; layout?: WorkspaceLayoutDTO },
    now: Date
  ): Promise<MachineWorkspaceRecord | null>;
  /** `true` if a row was actually deleted. */
  remove(machineId: string, id: string): Promise<boolean>;
}

/** Re-exported so callers can classify an `insertIfAbsent` race without importing the DB layer directly. */
export { isUniqueViolation };

function toRecord(row: {
  id: string;
  ownerId: string;
  machineId: string;
  scope: string;
  projectName: string | null;
  branchName: string | null;
  name: string;
  layout: unknown;
  createdAt: Date;
  updatedAt: Date;
}): MachineWorkspaceRecord {
  return {
    ...row,
    scope: row.scope as MachineWorkspaceRecord['scope'],
    layout: row.layout as WorkspaceLayoutDTO,
  };
}

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * tables, and operators so callers that inject a fake (in tests) never load
 * the DB module graph — same laziness as `createDbMachineProjectStore`.
 */
export async function createDbMachineWorkspaceStore(): Promise<MachineWorkspaceStore> {
  const [{ db }, { eq, and, asc }, { machineWorkspaces }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-workspaces'),
  ]);

  return {
    async list(machineId) {
      const rows = await db
        .select()
        .from(machineWorkspaces)
        .where(eq(machineWorkspaces.machineId, machineId))
        .orderBy(asc(machineWorkspaces.createdAt), asc(machineWorkspaces.id));
      return rows.map(toRecord);
    },

    async findById(machineId, id) {
      const [row] = await db
        .select()
        .from(machineWorkspaces)
        .where(and(eq(machineWorkspaces.machineId, machineId), eq(machineWorkspaces.id, id)))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    async insertIfAbsent(input) {
      const [inserted] = await db
        .insert(machineWorkspaces)
        .values({
          id: input.id,
          ownerId: input.ownerId,
          machineId: input.machineId,
          scope: input.scope,
          projectName: input.projectName,
          branchName: input.branchName,
          name: input.name,
          layout: input.layout,
          createdAt: input.now,
          updatedAt: input.now,
        })
        // Conflict target is the COMPOUND primary key, not `id` alone —
        // `sessionWorkspaceId` has no machineId in it, so two different
        // Machines can legitimately mint the identical id for their own,
        // unrelated sessions (see schema doc). Scoping by machineId here too
        // is what keeps that a non-collision.
        .onConflictDoNothing({ target: [machineWorkspaces.machineId, machineWorkspaces.id] })
        .returning();
      if (inserted) return { created: true, row: toRecord(inserted) };

      const [existing] = await db
        .select()
        .from(machineWorkspaces)
        .where(and(eq(machineWorkspaces.machineId, input.machineId), eq(machineWorkspaces.id, input.id)))
        .limit(1);
      if (!existing) {
        // The conflicting row was deleted between our failed insert and this
        // read — vanishingly rare, and there is no sane row to hand back.
        throw new Error(`machine-workspaces: insertIfAbsent lost its conflict target ${input.machineId}/${input.id}`);
      }
      return { created: false, row: toRecord(existing) };
    },

    async update(machineId, id, patch, now) {
      const [row] = await db
        .update(machineWorkspaces)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
          updatedAt: now,
        })
        .where(and(eq(machineWorkspaces.machineId, machineId), eq(machineWorkspaces.id, id)))
        .returning();
      return row ? toRecord(row) : null;
    },

    async remove(machineId, id) {
      const rows = await db
        .delete(machineWorkspaces)
        .where(and(eq(machineWorkspaces.machineId, machineId), eq(machineWorkspaces.id, id)))
        .returning({ id: machineWorkspaces.id });
      return rows.length > 0;
    },
  };
}
