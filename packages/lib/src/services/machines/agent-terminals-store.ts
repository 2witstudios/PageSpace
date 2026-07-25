/**
 * Agent Terminals store (IO, dependency-injected).
 *
 * DB-backed CRUD for the `machine_agent_terminals` table — the durable record
 * of which named, pluggable-agent-typed PTY sessions exist at a given
 * Terminal scope (machine / project / branch — see the schema module doc).
 * Kept separate from the spawn/attach/kill orchestration (agent-terminals.ts)
 * so that orchestration logic is testable against an in-memory fake without a
 * real database.
 */

import { isUniqueViolation } from '../subdomain-allocation';

export type AgentTerminalScope = 'machine' | 'project' | 'branch';

export interface MachineAgentTerminalRecord {
  id: string;
  ownerId: string;
  machineId: string;
  scope: AgentTerminalScope;
  projectName: string | null;
  machineBranchId: string | null;
  name: string;
  agentType: string;
  command: string | null;
  streamSessionId: string | null;
  /**
   * The opaque HMAC name this session's OWN Sprite is provisioned under
   * (`deriveAgentTerminalSessionSpriteKey`). NULL on legacy/unprovisioned rows.
   */
  sessionKey: string | null;
  /** This session's OWN Sprite NAME (reused across re-creates, so NOT an identity). NULL until first provisioned; the shared-Sprite fallback resolves such rows. */
  sandboxId: string | null;
  /** WHICH VM this row's Sprite is. NULL on legacy rows. Every teardown CAS keys on this, because `sandboxId` cannot tell a replacement Sprite from its predecessor. */
  spriteInstanceId: string | null;
  /** Egress-lockdown proof for this session's VM, handed back on the next provision. NULL when unproven. */
  egressPolicyToken: string | null;
  /** When a teardown of this session's Sprite was REQUESTED. Cleared whenever a live Sprite is recorded. */
  teardownRequestedAt: Date | null;
  /** When this session's Sprite was CONFIRMED destroyed; NULL while we believe it is live. A stamped row resolves via the shared-Sprite fallback. */
  spriteTornDownAt: Date | null;
  /** The tail of the LAST DEAD incarnation's scrollback — see `recordColdTail`. Null until the first teardown. */
  coldTail: string | null;
  /** When the PTY that produced `coldTail` ended. */
  coldTailAt: Date | null;
  /** Whether that dead PTY ever emitted a byte — carried separately from `coldTail` for the same reason `TerminalSession.hasOutput` is (an empty tail is not proof of silence). */
  coldTailHasOutput: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineAgentTerminalInput {
  ownerId: string;
  machineId: string;
  scope: AgentTerminalScope;
  projectName: string | null;
  machineBranchId: string | null;
  name: string;
  agentType: string;
  command: string | null;
  now: Date;
}

/** Identifies WHICH machine/project/branch scope a row (or a lookup) belongs to — the store's addressing key for spawn/list. */
export interface AgentTerminalScopeKey {
  machineId: string;
  projectName: string | null;
  machineBranchId: string | null;
}

/**
 * Classify a scope key's discriminant: `machineBranchId` set → branch, else
 * `projectName` set → project, else machine. The SINGLE derivation used to
 * populate the explicit `scope` column at creation (see `spawnAgentTerminal`
 * in `agent-terminals.ts`) — never recomputed afterward, since a row's scope
 * is immutable for its lifetime.
 */
export function deriveAgentTerminalScope(key: {
  projectName: string | null;
  machineBranchId: string | null;
}): AgentTerminalScope {
  if (key.machineBranchId) return 'branch';
  if (key.projectName) return 'project';
  return 'machine';
}

export interface MachineAgentTerminalStore {
  list(scope: AgentTerminalScopeKey): Promise<MachineAgentTerminalRecord[]>;
  findByName(scope: AgentTerminalScopeKey, name: string): Promise<MachineAgentTerminalRecord | null>;
  /**
   * Level-agnostic lookup by the row's OWN id — no scope path required
   * (mirrors PurePoint's `Attach{agent_id}`). Performs no access check; a
   * caller learns the row's `machineId` only from the returned record, so it
   * must authorize against that before trusting or acting on the result.
   */
  findById(id: string): Promise<MachineAgentTerminalRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (scope, name) already exists. */
  create(input: NewMachineAgentTerminalInput): Promise<MachineAgentTerminalRecord>;
  updateStreamSessionId(input: { id: string; streamSessionId: string; now: Date }): Promise<void>;
  /**
   * Overwrite this row's cold-tail columns IN PLACE — the tail of the incarnation
   * that JUST ended, replacing whatever an earlier incarnation left. All three
   * columns are always written together, so a fresh short-lived incarnation
   * never leaves a stale tail paired with a new `hasOutput`/`endedAt`.
   *
   * ORDERED BY `endedAt`, not by write-arrival order: `endAgentTerminalSession`
   * calls this fire-and-forget, so a reopen-and-teardown that races a still-
   * in-flight earlier write must not let a delayed OLD write clobber a NEWER
   * incarnation's tail — a no-op when `endedAt` is not strictly after whatever
   * `coldTailAt` already holds.
   *
   * Deliberately does NOT touch `updatedAt`: that column feeds
   * `readSessionState`'s liveness fallback (`session-tools.ts`) when the
   * realtime sweep is unreachable, and this write is recording that the PTY
   * has ENDED — bumping it would make a just-died session read as `active`
   * for up to `SESSION_ACTIVE_WINDOW_MS` at exactly the moment the sweep can't
   * correct it.
   */
  recordColdTail(input: { id: string; tail: string; hasOutput: boolean; endedAt: Date }): Promise<void>;
  /**
   * Record this session's freshly-provisioned Sprite identity onto its row,
   * under a compare-and-swap on the CURRENT `sandboxId` — the agent-terminal
   * twin of `MachineBranchStore.updateSandboxId`. `previousSandboxId` is `null`
   * for a FIRST provision (the row was reserved with a NULL Sprite) and the
   * vanished Sprite's name when re-provisioning after it disappeared. Two
   * concurrent provisions of the same unprovisioned row race here; the loser
   * sees `false` and reconciles rather than orphaning its own live VM. Also
   * clears `spriteTornDownAt`/`teardownRequestedAt` (a new generation voids a
   * stale teardown), same as `revivedBranchColumns`.
   */
  updateSpriteIdentity(input: {
    id: string;
    previousSandboxId: string | null;
    sessionKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    now: Date;
  }): Promise<boolean>;
  /**
   * Stamp `spriteTornDownAt` on this row after its Sprite is CONFIRMED killed,
   * under a CAS on the INSTANCE — the agent-terminal twin of the branch/project
   * teardown stamp. Keeps the row (its FK-cascade and reservation live on); a
   * concurrent re-provision that wrote a LIVE replacement instance is protected
   * by the CAS. Returns whether it stamped.
   */
  stampSpriteTornDown(input: { id: string; sandboxId: string; spriteInstanceId: string | null; now: Date }): Promise<boolean>;
  /**
   * Compare-and-swap removal by row id: deletes ONLY if the row still points at
   * `sandboxId` (and instance). Use this — never the name-keyed `remove` —
   * after killing a session's OWN Sprite, for the same reason
   * `MachineBranchStore.removeIfSandbox` exists: a concurrent re-spawn can write
   * a replacement Sprite into the row between the kill and the delete, and a
   * name-keyed delete would strand that live VM. Drops the rescued reclaim
   * pointer with the row (the Sprite is already confirmed dead).
   */
  removeIfSandbox(input: { id: string; sandboxId: string; spriteInstanceId: string | null }): Promise<boolean>;
  /**
   * Compare-and-swap removal that RESCUES the Sprite pointer instead of dropping
   * it — the twin of `removeIfSandbox` for an UNCONFIRMED kill.
   *
   * Deletes the row ONLY if it still points at (`sandboxId`, `spriteInstanceId`),
   * exactly like `removeIfSandbox`, so a concurrent re-spawn's live replacement is
   * never stranded. But it does NOT drop the reclaim-outbox pointer the
   * AFTER-DELETE trigger enqueues as the row goes — so a Sprite whose kill could
   * NOT be confirmed is left for the orphan reconciler's tier-A to retry, rather
   * than billing forever. Use `removeIfSandbox` when the kill IS confirmed (drop
   * the redundant pointer); use this when it is not (keep it).
   */
  removeIfSandboxToReclaim(input: { id: string; sandboxId: string; spriteInstanceId: string | null }): Promise<boolean>;
  /**
   * Enqueue a Sprite pointer directly into the reclaim outbox
   * (`machine_sprite_reclaims`) — for a Sprite that was PROVISIONED but never
   * recorded on any row (its row still has a NULL `sandboxId`), so neither an
   * AFTER-DELETE trigger nor the tracking-row reconciler could ever find it. The
   * provisioning failure path uses this when a cleanup kill cannot be confirmed.
   * Idempotent (ON CONFLICT), mirroring the trigger's own insert.
   */
  enqueueReclaim(input: { sandboxId: string; spriteInstanceId: string | null }): Promise<void>;
  remove(scope: AgentTerminalScopeKey, name: string): Promise<void>;
}

/**
 * What recording a live (re-)provisioned Sprite writes onto a
 * `machine_agent_terminals` row (pure) — the agent-terminal twin of
 * `revivedBranchColumns`. A new Sprite generation voids BOTH teardown marks and
 * resets the storage accounting period, so a revived row never bills the dead
 * generation's measured size for a window it did not exist.
 */
export function revivedAgentTerminalColumns(input: {
  sessionKey: string;
  sandboxId: string;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  now: Date;
}): {
  sessionKey: string;
  sandboxId: string;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  spriteTornDownAt: null;
  teardownRequestedAt: null;
  storageLastBilledAt: Date;
  storageMeasuredBytes: null;
  storageMeasuredAt: null;
  updatedAt: Date;
} {
  return {
    sessionKey: input.sessionKey,
    sandboxId: input.sandboxId,
    spriteInstanceId: input.spriteInstanceId,
    egressPolicyToken: input.egressPolicyToken,
    spriteTornDownAt: null,
    teardownRequestedAt: null,
    storageLastBilledAt: input.now,
    storageMeasuredBytes: null,
    storageMeasuredAt: null,
    updatedAt: input.now,
  };
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineAgentTerminalStore(): Promise<MachineAgentTerminalStore> {
  const [{ db }, { eq, and, or, lt, isNull, eqOrIsNull, sql }, { machineAgentTerminals }, { machineSpriteReclaims }] =
    await Promise.all([
      import('@pagespace/db/db'),
      import('@pagespace/db/operators'),
      import('@pagespace/db/schema/machine-agent-terminals'),
      import('@pagespace/db/schema/machine-sprite-reclaims'),
    ]);

  // Coalescing equality: a NULL scope column (machine/project scope) must
  // match other NULLs, not just itself — plain `eq` never matches NULL in SQL.
  function scopeCondition(scope: AgentTerminalScopeKey) {
    return and(
      eq(machineAgentTerminals.machineId, scope.machineId),
      scope.projectName === null
        ? isNull(machineAgentTerminals.projectName)
        : eq(machineAgentTerminals.projectName, scope.projectName),
      scope.machineBranchId === null
        ? isNull(machineAgentTerminals.machineBranchId)
        : eq(machineAgentTerminals.machineBranchId, scope.machineBranchId),
    );
  }

  return {
    async list(scope) {
      const rows = await db.select().from(machineAgentTerminals).where(scopeCondition(scope));
      return rows as MachineAgentTerminalRecord[];
    },

    async findByName(scope, name) {
      const [row] = await db
        .select()
        .from(machineAgentTerminals)
        .where(and(scopeCondition(scope), eq(machineAgentTerminals.name, name)))
        .limit(1);
      return (row as MachineAgentTerminalRecord) ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(machineAgentTerminals).where(eq(machineAgentTerminals.id, id)).limit(1);
      return (row as MachineAgentTerminalRecord) ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(machineAgentTerminals)
        .values({
          ownerId: input.ownerId,
          machineId: input.machineId,
          scope: input.scope,
          projectName: input.projectName,
          machineBranchId: input.machineBranchId,
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
      return row as MachineAgentTerminalRecord;
    },

    async updateStreamSessionId({ id, streamSessionId, now }) {
      await db
        .update(machineAgentTerminals)
        .set({ streamSessionId, updatedAt: now })
        .where(eq(machineAgentTerminals.id, id));
    },

    async recordColdTail({ id, tail, hasOutput, endedAt }) {
      await db
        .update(machineAgentTerminals)
        .set({ coldTail: tail, coldTailAt: endedAt, coldTailHasOutput: hasOutput })
        .where(
          and(
            eq(machineAgentTerminals.id, id),
            or(isNull(machineAgentTerminals.coldTailAt), lt(machineAgentTerminals.coldTailAt, endedAt)),
          ),
        );
    },

    async updateSpriteIdentity({ id, previousSandboxId, sessionKey, sandboxId, spriteInstanceId, egressPolicyToken, now }) {
      const updated = await db
        .update(machineAgentTerminals)
        .set(revivedAgentTerminalColumns({ sessionKey, sandboxId, spriteInstanceId, egressPolicyToken, now }))
        // CAS on the CURRENT sandboxId: null for a first provision, the vanished
        // name for a re-provision. `eqOrIsNull` matches the null case.
        .where(and(eq(machineAgentTerminals.id, id), eqOrIsNull(machineAgentTerminals.sandboxId, previousSandboxId)))
        .returning({ id: machineAgentTerminals.id });
      return updated.length > 0;
    },

    async stampSpriteTornDown({ id, sandboxId, spriteInstanceId, now }) {
      const updated = await db
        .update(machineAgentTerminals)
        .set({ spriteTornDownAt: now })
        // CAS on the INSTANCE, not the name: a concurrent re-provision may have
        // written a LIVE replacement into this row, and stamping that as torn
        // down would hide a billing VM from the reconciler forever.
        .where(
          and(
            eq(machineAgentTerminals.id, id),
            eq(machineAgentTerminals.sandboxId, sandboxId),
            eqOrIsNull(machineAgentTerminals.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: machineAgentTerminals.id });
      return updated.length > 0;
    },

    async removeIfSandbox({ id, sandboxId, spriteInstanceId }) {
      // One transaction — see the identical note in `createDbMachineBranchStore`.
      // The AFTER DELETE trigger rescues this row's sandboxId into the reclaim
      // outbox as it goes; here the Sprite is already CONFIRMED dead, so we drop
      // the rescued pointer with it rather than pay a redundant kill next tick.
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(machineAgentTerminals)
          .where(
            and(
              eq(machineAgentTerminals.id, id),
              eq(machineAgentTerminals.sandboxId, sandboxId),
              eqOrIsNull(machineAgentTerminals.spriteInstanceId, spriteInstanceId),
            ),
          )
          .returning({ id: machineAgentTerminals.id });
        if (deleted.length === 0) return false;
        await tx.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
        return true;
      });
    },

    async removeIfSandboxToReclaim({ id, sandboxId, spriteInstanceId }) {
      // Same CAS delete as `removeIfSandbox`, but WITHOUT dropping the reclaim
      // pointer: the AFTER-DELETE trigger enqueues this row's (sandboxId,
      // spriteInstanceId) into `machine_sprite_reclaims` as the row goes, and we
      // LEAVE it there so the orphan reconciler's tier-A retries the kill — for a
      // Sprite whose kill could not be confirmed. No transaction/reclaim-drop.
      const deleted = await db
        .delete(machineAgentTerminals)
        .where(
          and(
            eq(machineAgentTerminals.id, id),
            eq(machineAgentTerminals.sandboxId, sandboxId),
            eqOrIsNull(machineAgentTerminals.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: machineAgentTerminals.id });
      return deleted.length > 0;
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Mirror the AFTER-DELETE trigger's own insert (0209/0229): idempotent on
      // the sandboxId PK, chasing the newest instance on conflict.
      await db
        .insert(machineSpriteReclaims)
        .values({ sandboxId, spriteInstanceId })
        .onConflictDoUpdate({
          target: machineSpriteReclaims.sandboxId,
          // Prefer the INCOMING instance — a newer generation took this
          // deterministic name, so the outbox pointer must chase the VM that is
          // actually alive now, not the one a stale row remembers. Matches the
          // 0229 AFTER-DELETE trigger's `COALESCE(EXCLUDED, existing)` exactly;
          // the reverse order would let the reconciler kill the old (already
          // gone) instance, treat MachineSpriteReplacedError as done, drop the
          // row, and leave the live replacement billing untracked.
          set: { spriteInstanceId: sql`coalesce(excluded."spriteInstanceId", ${machineSpriteReclaims.spriteInstanceId})` },
        });
    },

    async remove(scope, name) {
      await db
        .delete(machineAgentTerminals)
        .where(and(scopeCondition(scope), eq(machineAgentTerminals.name, name)));
    },
  };
}
