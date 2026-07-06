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
  terminalId: string;
  scope: AgentTerminalScope;
  projectName: string | null;
  machineBranchId: string | null;
  name: string;
  agentType: string;
  command: string | null;
  streamSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineAgentTerminalInput {
  ownerId: string;
  terminalId: string;
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
  terminalId: string;
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
  /** Level-agnostic lookup by the row's OWN id — no scope path required (mirrors PurePoint's `Attach{agent_id}`). */
  findById(id: string): Promise<MachineAgentTerminalRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (scope, name) already exists. */
  create(input: NewMachineAgentTerminalInput): Promise<MachineAgentTerminalRecord>;
  updateStreamSessionId(input: { id: string; streamSessionId: string; now: Date }): Promise<void>;
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
  const [{ db }, { eq, and, isNull }, { machineAgentTerminals }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-agent-terminals'),
  ]);

  // Coalescing equality: a NULL scope column (machine/project scope) must
  // match other NULLs, not just itself — plain `eq` never matches NULL in SQL.
  function scopeCondition(scope: AgentTerminalScopeKey) {
    return and(
      eq(machineAgentTerminals.terminalId, scope.terminalId),
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
          terminalId: input.terminalId,
          scope: input.scope,
          projectName: input.projectName,
          machineBranchId: input.machineBranchId,
          name: input.name,
          agentType: input.agentType,
          command: input.command,
          streamSessionId: null,
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

    async remove(scope, name) {
      await db
        .delete(machineAgentTerminals)
        .where(and(scopeCondition(scope), eq(machineAgentTerminals.name, name)));
    },
  };
}
