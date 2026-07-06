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
  terminalId: string;
  projectName: string;
  branchName: string;
  sessionKey: string;
  sandboxId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineBranchInput {
  ownerId: string;
  terminalId: string;
  projectName: string;
  branchName: string;
  sessionKey: string;
  sandboxId: string;
  now: Date;
}

export interface MachineBranchStore {
  list(terminalId: string, projectName: string): Promise<MachineBranchRecord[]>;
  findByName(terminalId: string, projectName: string, branchName: string): Promise<MachineBranchRecord | null>;
  /** Level-agnostic lookup by the branch-terminal's own row id — no project/branch name path required (mirrors PurePoint's `Attach{agent_id}`). */
  findById(id: string): Promise<MachineBranchRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (terminalId, projectName, branchName) already exists. */
  create(input: NewMachineBranchInput): Promise<MachineBranchRecord>;
  /**
   * Conditional update — only writes if the row's CURRENT `sandboxId` still
   * equals `previousSandboxId`, returning whether it actually updated. This
   * is a compare-and-swap: two concurrent re-provisions racing to record a
   * replacement Sprite for the same vanished one must not silently
   * last-write-wins (the loser's win would orphan its own live Sprite,
   * untracked) — the loser instead sees `updated: false` and can react.
   */
  updateSandboxId(input: { id: string; previousSandboxId: string; sandboxId: string; now: Date }): Promise<boolean>;
  remove(terminalId: string, projectName: string, branchName: string): Promise<void>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineBranchStore(): Promise<MachineBranchStore> {
  const [{ db }, { eq, and }, { machineBranches }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-branches'),
  ]);

  return {
    async list(terminalId, projectName) {
      const rows = await db
        .select()
        .from(machineBranches)
        .where(and(eq(machineBranches.terminalId, terminalId), eq(machineBranches.projectName, projectName)));
      return rows;
    },

    async findByName(terminalId, projectName, branchName) {
      const [row] = await db
        .select()
        .from(machineBranches)
        .where(
          and(
            eq(machineBranches.terminalId, terminalId),
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
          terminalId: input.terminalId,
          projectName: input.projectName,
          branchName: input.branchName,
          sessionKey: input.sessionKey,
          sandboxId: input.sandboxId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row;
    },

    async updateSandboxId({ id, previousSandboxId, sandboxId, now }) {
      const updated = await db
        .update(machineBranches)
        .set({ sandboxId, updatedAt: now })
        .where(and(eq(machineBranches.id, id), eq(machineBranches.sandboxId, previousSandboxId)))
        .returning({ id: machineBranches.id });
      return updated.length > 0;
    },

    async remove(terminalId, projectName, branchName) {
      await db
        .delete(machineBranches)
        .where(
          and(
            eq(machineBranches.terminalId, terminalId),
            eq(machineBranches.projectName, projectName),
            eq(machineBranches.branchName, branchName),
          ),
        );
    },
  };
}
