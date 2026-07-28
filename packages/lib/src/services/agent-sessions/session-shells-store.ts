/**
 * Session Shells store (IO, dependency-injected).
 *
 * DB-backed CRUD for `agent_session_shells` — the named PTYs inside a session's
 * ONE shared sandbox. The gutted successor to
 * `services/machines/agent-terminals-store.ts`, and what it LOST is the point:
 *
 *  - **No scope key.** The predecessor addressed every row by a
 *    `(machineId, projectName, machineBranchId)` tuple and needed coalescing
 *    NULL-equality SQL to look one up, because a row's identity was where it
 *    lived. A shell is addressed by `id` and enumerated by `sessionId`, both
 *    plain equality on indexed columns.
 *  - **No Sprite columns, and so no Sprite CAS at all.** The SESSION owns the
 *    VM; a shell owns a process on it. That deletes `updateSpriteIdentity`,
 *    `stampSpriteTornDown`, `removeIfSandbox`, `removeIfSandboxToReclaim`,
 *    `removeIfUnprovisioned` and `enqueueReclaim` — six methods that existed
 *    only to stop a per-terminal VM from being stranded. Deleting a shell row
 *    strands nothing, which is why `agent_session_shells` carries no reclaim
 *    trigger either.
 *
 * What survives is the durable record of which named PTYs exist, plus the
 * cold-tail columns, which are unchanged in every detail (see `recordColdTail`).
 */

import { isUniqueViolation } from '../subdomain-allocation';

/** One `agent_session_shells` row. `id` IS the shellId — the wire address. */
export interface SessionShellRecord {
  id: string;
  /** ≡ the conversation id of the owning session. */
  sessionId: string;
  ownerId: string;
  /** Tab label. Unique within a session for tab clarity — still not an address. */
  name: string;
  agentType: string;
  /** Optional per-shell program override; null runs the agent type's default. */
  command: string | null;
  /** The Sprite exec session id this PTY was created/reattached under. NULL until the bridge's first connect. */
  streamSessionId: string | null;
  coldTail: string | null;
  coldTailAt: Date | null;
  coldTailHasOutput: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSessionShellInput {
  sessionId: string;
  ownerId: string;
  name: string;
  agentType: string;
  command: string | null;
  now: Date;
}

export interface SessionShellStore {
  list(sessionId: string): Promise<SessionShellRecord[]>;
  /**
   * Lookup by the row's OWN id — the only lookup that exists, because the id is
   * the only address. Performs NO access check: a caller learns which session
   * (and therefore which owner and agent page) a shell belongs to only from the
   * returned record, so it must authorize against THAT before acting on it.
   */
  findById(id: string): Promise<SessionShellRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (sessionId, name) already exists. */
  create(input: NewSessionShellInput): Promise<SessionShellRecord>;
  updateStreamSessionId(input: { id: string; streamSessionId: string; now: Date }): Promise<void>;
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
export async function createDbSessionShellStore(): Promise<SessionShellStore> {
  const [{ db }, { eq, and, or, lt, isNull }, { agentSessionShells }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/agent-sessions'),
  ]);

  return {
    async list(sessionId) {
      const rows = await db.select().from(agentSessionShells).where(eq(agentSessionShells.sessionId, sessionId));
      return rows as SessionShellRecord[];
    },

    async findById(id) {
      const [row] = await db.select().from(agentSessionShells).where(eq(agentSessionShells.id, id)).limit(1);
      return (row as SessionShellRecord) ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(agentSessionShells)
        .values({
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          name: input.name,
          agentType: input.agentType,
          command: input.command,
          streamSessionId: null,
          coldTail: null,
          coldTailAt: null,
          coldTailHasOutput: false,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row as SessionShellRecord;
    },

    async updateStreamSessionId({ id, streamSessionId, now }) {
      await db
        .update(agentSessionShells)
        .set({ streamSessionId, updatedAt: now })
        .where(eq(agentSessionShells.id, id));
    },

    async recordColdTail({ id, tail, hasOutput, endedAt }) {
      await db
        .update(agentSessionShells)
        .set({ coldTail: tail, coldTailAt: endedAt, coldTailHasOutput: hasOutput })
        .where(
          and(
            eq(agentSessionShells.id, id),
            or(isNull(agentSessionShells.coldTailAt), lt(agentSessionShells.coldTailAt, endedAt)),
          ),
        );
    },

    async remove(id) {
      await db.delete(agentSessionShells).where(eq(agentSessionShells.id, id));
    },
  };
}
