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
  remove(scope: AgentTerminalScopeKey, name: string): Promise<void>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineAgentTerminalStore(): Promise<MachineAgentTerminalStore> {
  const [{ db }, { eq, and, or, lt, isNull }, { machineAgentTerminals }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-agent-terminals'),
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

    async remove(scope, name) {
      await db
        .delete(machineAgentTerminals)
        .where(and(scopeCondition(scope), eq(machineAgentTerminals.name, name)));
    },
  };
}
