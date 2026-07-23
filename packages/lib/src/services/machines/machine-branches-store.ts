/**
 * Machine Branches store (IO, dependency-injected).
 *
 * DB-backed CRUD for the `machine_branches` table — the durable record of
 * which branch-terminals exist for a Project, and which Sprite (`sandboxId`,
 * addressed by the opaque `sessionKey`) each one is provisioned as. Kept
 * separate from the spawn/attach/kill orchestration (machine-branches.ts) so
 * that orchestration logic is testable against an in-memory fake without a
 * real database.
 */

import { isUniqueViolation } from '../subdomain-allocation';

export interface MachineBranchRecord {
  id: string;
  ownerId: string;
  machineId: string;
  projectName: string;
  branchName: string;
  sessionKey: string;
  /** The Sprite's NAME — reused across re-creates, so NOT an identity. */
  sandboxId: string;
  /** WHICH VM this row points at. Null on legacy rows. Every teardown CAS keys on this, because `sandboxId` cannot tell a replacement Sprite from its predecessor. */
  spriteInstanceId: string | null;
  /** When a teardown of this branch's Sprite was REQUESTED (`deleteMachine` ran). Cleared whenever a live Sprite is recorded — a stale request must never license destroying a VM the user can still restore. */
  teardownRequestedAt: Date | null;
  /**
   * When `sandboxId`'s Sprite was CONFIRMED destroyed; NULL while we believe it
   * is live. The row deliberately OUTLIVES its Sprite — it is re-creatable
   * config (`spawnBranch` re-provisions under the same `sessionKey`), so a
   * teardown stamps this instead of deleting the row. See the column's doc in
   * `@pagespace/db/schema/machine-branches`.
   */
  spriteTornDownAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineBranchInput {
  ownerId: string;
  machineId: string;
  projectName: string;
  branchName: string;
  sessionKey: string;
  sandboxId: string;
  spriteInstanceId: string | null;
  now: Date;
}

export interface MachineBranchStore {
  list(machineId: string, projectName: string): Promise<MachineBranchRecord[]>;
  /** Every branch of the machine in one read — the machine-root cascade derivation's query (see `MachinePaneBindingBranchLookup.listAll`). */
  listForMachine(machineId: string): Promise<MachineBranchRecord[]>;
  findByName(machineId: string, projectName: string, branchName: string): Promise<MachineBranchRecord | null>;
  /** Level-agnostic lookup by the branch-terminal's own row id — no project/branch name path required (mirrors PurePoint's `Attach{agent_id}`). */
  findById(id: string): Promise<MachineBranchRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (machineId, projectName, branchName) already exists. */
  create(input: NewMachineBranchInput): Promise<MachineBranchRecord>;
  /**
   * Conditional update — only writes if the row's CURRENT `sandboxId` still
   * equals `previousSandboxId`, returning whether it actually updated. This
   * is a compare-and-swap: two concurrent re-provisions racing to record a
   * replacement Sprite for the same vanished one must not silently
   * last-write-wins (the loser's win would orphan its own live Sprite,
   * untracked) — the loser instead sees `updated: false` and can react.
   *
   * Recording a live replacement Sprite also CLEARS `spriteTornDownAt`: this is
   * the sole re-provision write path, so if it left a stale torn-down stamp
   * behind, the brand-new Sprite would be invisible to both the orphan
   * reconciler and the hard-purge guard — i.e. it could be orphaned and billed
   * forever, the exact bug this all exists to prevent.
   */
  updateSandboxId(input: {
    id: string;
    previousSandboxId: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    now: Date;
  }): Promise<boolean>;
  remove(machineId: string, projectName: string, branchName: string): Promise<void>;
  /**
   * Compare-and-swap removal by row id: deletes ONLY if the row still points at
   * `sandboxId`.
   *
   * Use this — never the name-keyed `remove` — after killing a branch's Sprite.
   * `spawnBranch` re-provisions a vanished branch under the SAME (machineId,
   * projectName, branchName) identity, so between the kill and the delete a
   * concurrent spawn can write a REPLACEMENT Sprite into this very row. A
   * name-keyed delete would then destroy the pointer to that brand-new, LIVE
   * Sprite, leaving it billing forever with nothing — not even the orphan
   * reconciler — able to find it.
   */
  removeIfSandbox(input: { id: string; sandboxId: string; spriteInstanceId: string | null }): Promise<boolean>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineBranchStore(): Promise<MachineBranchStore> {
  const [{ db }, { eq, and, eqOrIsNull }, { machineBranches }, { machineSpriteReclaims }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-branches'),
    import('@pagespace/db/schema/machine-sprite-reclaims'),
  ]);

  return {
    async list(machineId, projectName) {
      const rows = await db
        .select()
        .from(machineBranches)
        .where(and(eq(machineBranches.machineId, machineId), eq(machineBranches.projectName, projectName)));
      return rows;
    },

    async listForMachine(machineId) {
      const rows = await db
        .select()
        .from(machineBranches)
        .where(eq(machineBranches.machineId, machineId));
      return rows;
    },

    async findByName(machineId, projectName, branchName) {
      const [row] = await db
        .select()
        .from(machineBranches)
        .where(
          and(
            eq(machineBranches.machineId, machineId),
            eq(machineBranches.projectName, projectName),
            eq(machineBranches.branchName, branchName),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(machineBranches).where(eq(machineBranches.id, id)).limit(1);
      return row ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(machineBranches)
        .values({
          ownerId: input.ownerId,
          machineId: input.machineId,
          projectName: input.projectName,
          branchName: input.branchName,
          sessionKey: input.sessionKey,
          sandboxId: input.sandboxId,
          spriteInstanceId: input.spriteInstanceId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row;
    },

    async updateSandboxId({ id, previousSandboxId, sandboxId, spriteInstanceId, now }) {
      const updated = await db
        .update(machineBranches)
        .set({
          sandboxId,
          spriteInstanceId,
          // This row points at a LIVE Sprite again, so BOTH teardown marks are void:
          // `spriteTornDownAt` (it is not torn down) and `teardownRequestedAt` (the
          // request was against the PREVIOUS VM). Leaving the request set would let
          // the reconciler destroy this live VM — and would turn a later REVERSIBLE
          // trash of the restored Machine into an irreversible kill.
          spriteTornDownAt: null,
          teardownRequestedAt: null,
          updatedAt: now,
        })
        .where(and(eq(machineBranches.id, id), eq(machineBranches.sandboxId, previousSandboxId)))
        .returning({ id: machineBranches.id });
      return updated.length > 0;
    },

    async remove(machineId, projectName, branchName) {
      await db
        .delete(machineBranches)
        .where(
          and(
            eq(machineBranches.machineId, machineId),
            eq(machineBranches.projectName, projectName),
            eq(machineBranches.branchName, branchName),
          ),
        );
    },

    async removeIfSandbox({ id, sandboxId, spriteInstanceId }) {
      // One transaction — see the identical note in `createDbMachineSessionStore`.
      // The AFTER DELETE trigger rescues this row's sandboxId into the reclaim
      // outbox as it goes; here the Sprite is already CONFIRMED dead, so we drop
      // the rescued pointer with it rather than pay a redundant kill next tick.
      return db.transaction(async (tx) => {
        // CAS on the INSTANCE: `sandboxId` is a reused name, so it cannot tell a
        // replacement VM from the one we killed.
        const deleted = await tx
          .delete(machineBranches)
          .where(
            and(
              eq(machineBranches.id, id),
              eq(machineBranches.sandboxId, sandboxId),
              eqOrIsNull(machineBranches.spriteInstanceId, spriteInstanceId),
            ),
          )
          .returning({ id: machineBranches.id });
        if (deleted.length === 0) return false;
        await tx.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
        return true;
      });
    },
  };
}
