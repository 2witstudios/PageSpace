/**
 * Session Shells store (IO, dependency-injected).
 *
 * DB-backed CRUD for `agent_workspace_shells` — the named PTYs inside a session's
 * ONE shared sandbox. The gutted successor to
 * `services/machines/agent-terminals-store.ts`, and what it LOST is the point:
 *
 *  - **No scope key.** The predecessor addressed every row by a
 *    `(machineId, projectName, machineBranchId)` tuple and needed coalescing
 *    NULL-equality SQL to look one up, because a row's identity was where it
 *    lived. A shell is addressed by `id` and enumerated by `workspaceId`, both
 *    plain equality on indexed columns.
 *  - **No Sprite columns, and so no Sprite CAS at all.** The SESSION owns the
 *    VM; a shell owns a process on it. That deletes `updateSpriteIdentity`,
 *    `stampSpriteTornDown`, `removeIfSandbox`, `removeIfSandboxToReclaim`,
 *    `removeIfUnprovisioned` and `enqueueReclaim` — six methods that existed
 *    only to stop a per-terminal VM from being stranded. Deleting a shell row
 *    strands nothing, which is why `agent_workspace_shells` carries no reclaim
 *    trigger either.
 *
 * What survives is the durable record of which named PTYs exist, plus the
 * cold-tail columns, which are unchanged in every detail (see `recordColdTail`).
 */

import { isUniqueViolation } from '../subdomain-allocation';
import type { DbExecutor } from './workspace-lock';

/** One `agent_workspace_shells` row. `id` IS the shellId — the wire address. */
export interface SessionShellRecord {
  id: string;
  /** ≡ the conversation id of the owning session. */
  workspaceId: string;
  ownerId: string;
  /** Tab label. Unique within a session for tab clarity — still not an address. */
  name: string;
  agentType: string;
  /** Optional per-shell program override; null runs the agent type's default. */
  command: string | null;
  /** The Sprite exec session id this PTY was created/reattached under. NULL until the bridge's first connect. */
  spriteExecId: string | null;
  coldTail: string | null;
  coldTailAt: Date | null;
  coldTailHasOutput: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSessionShellInput {
  /**
   * The row's id, supplied by the CALLER.
   *
   * Optional, and the column keeps its own `$defaultFn` for every caller that
   * omits it. It exists because a shell's membership node has to name the shell
   * it binds, and that node is decided against the workspace's tree BEFORE the
   * row is inserted — inside the same transaction, so a server-minted id here
   * would not be knowable in time. Minting it one step earlier is the same
   * convention the node model already runs on: ids come from the caller.
   */
  id?: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  agentType: string;
  command: string | null;
  now: Date;
}

export interface SessionShellStore {
  list(workspaceId: string): Promise<SessionShellRecord[]>;
  /**
   * Lookup by the row's OWN id — the only lookup that exists, because the id is
   * the only address. Performs NO access check: a caller learns which session
   * (and therefore which owner and agent page) a shell belongs to only from the
   * returned record, so it must authorize against THAT before acting on it.
   */
  findById(id: string): Promise<SessionShellRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (workspaceId, name) already exists. */
  create(input: NewSessionShellInput): Promise<SessionShellRecord>;
  updateSpriteExecId(input: { id: string; spriteExecId: string; now: Date }): Promise<void>;
  /**
   * Overwrite this row's cold-tail columns IN PLACE — the tail of the
   * incarnation that JUST ended, replacing whatever an earlier one left. All
   * three columns are always written together, so a fresh short-lived
   * incarnation never leaves a stale tail paired with a new
   * `hasOutput`/`endedAt`.
   *
   * ORDERED BY `endedAt`, not by write-arrival order: this is called
   * fire-and-forget, so a reopen-and-teardown that races a still-in-flight
   * earlier write must not let a delayed OLD write clobber a NEWER
   * incarnation's tail — a no-op when `endedAt` is not strictly after whatever
   * `coldTailAt` already holds.
   *
   * Deliberately does NOT touch `updatedAt`: this write records that the PTY has
   * ENDED, and bumping the column that feeds liveness fallbacks would make a
   * just-died shell read as active at exactly the wrong moment.
   */
  recordColdTail(input: { id: string; tail: string; hasOutput: boolean; endedAt: Date }): Promise<void>;
  /** Drop the row by id. Nothing to strand: the session owns the VM, so a removed shell leaves no Sprite pointer behind. */
  remove(id: string): Promise<void>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table and operators so callers that inject a fake (in tests) never load the DB
 * module graph.
 */
export async function createDbSessionShellStore(
  /**
   * Run every statement on THIS executor rather than the pooled `db`.
   *
   * The membership write passes the transaction its node write runs in, so a
   * shell row and the node that puts that shell in the workspace commit
   * together or not at all — the same property the conversation path gets from
   * the same funnel. A shell whose row landed and whose node did not is a
   * terminal the workspace holds and cannot show, which is the ghost this epic
   * deletes wearing a different hat.
   */
  executor?: DbExecutor,
): Promise<SessionShellStore> {
  const [{ db: pooled }, { eq, and, or, lt, isNull }, { agentWorkspaceShells }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/agent-workspaces'),
  ]);
  const db = executor ?? pooled;

  return {
    async list(workspaceId) {
      const rows = await db.select().from(agentWorkspaceShells).where(eq(agentWorkspaceShells.workspaceId, workspaceId));
      return rows as SessionShellRecord[];
    },

    async findById(id) {
      const [row] = await db.select().from(agentWorkspaceShells).where(eq(agentWorkspaceShells.id, id)).limit(1);
      return (row as SessionShellRecord) ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(agentWorkspaceShells)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          name: input.name,
          agentType: input.agentType,
          command: input.command,
          spriteExecId: null,
          coldTail: null,
          coldTailAt: null,
          coldTailHasOutput: false,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row as SessionShellRecord;
    },

    async updateSpriteExecId({ id, spriteExecId, now }) {
      await db
        .update(agentWorkspaceShells)
        .set({ spriteExecId, updatedAt: now })
        .where(eq(agentWorkspaceShells.id, id));
    },

    async recordColdTail({ id, tail, hasOutput, endedAt }) {
      await db
        .update(agentWorkspaceShells)
        .set({ coldTail: tail, coldTailAt: endedAt, coldTailHasOutput: hasOutput })
        .where(
          and(
            eq(agentWorkspaceShells.id, id),
            or(isNull(agentWorkspaceShells.coldTailAt), lt(agentWorkspaceShells.coldTailAt, endedAt)),
          ),
        );
    },

    async remove(id) {
      await db.delete(agentWorkspaceShells).where(eq(agentWorkspaceShells.id, id));
    },
  };
}
