/**
 * Agent Terminals store (IO, dependency-injected).
 *
 * DB-backed CRUD for the `machine_agent_terminals` table — the durable record
 * of which named, pluggable-agent-typed PTY sessions exist inside a
 * branch-terminal's Sprite. Kept separate from the spawn/attach/kill
 * orchestration (agent-terminals.ts) so that orchestration logic is testable
 * against an in-memory fake without a real database.
 */

import { isUniqueViolation } from '../subdomain-allocation';

export interface MachineAgentTerminalRecord {
  id: string;
  ownerId: string;
  machineBranchId: string;
  name: string;
  agentType: string;
  streamSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineAgentTerminalInput {
  ownerId: string;
  machineBranchId: string;
  name: string;
  agentType: string;
  now: Date;
}

export interface MachineAgentTerminalStore {
  list(machineBranchId: string): Promise<MachineAgentTerminalRecord[]>;
  findByName(machineBranchId: string, name: string): Promise<MachineAgentTerminalRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if this (machineBranchId, name) already exists. */
  create(input: NewMachineAgentTerminalInput): Promise<MachineAgentTerminalRecord>;
  updateStreamSessionId(input: { id: string; streamSessionId: string; now: Date }): Promise<void>;
  remove(machineBranchId: string, name: string): Promise<void>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineAgentTerminalStore(): Promise<MachineAgentTerminalStore> {
  const [{ db }, { eq, and }, { machineAgentTerminals }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-agent-terminals'),
  ]);

  return {
    async list(machineBranchId) {
      const rows = await db
        .select()
        .from(machineAgentTerminals)
        .where(eq(machineAgentTerminals.machineBranchId, machineBranchId));
      return rows;
    },

    async findByName(machineBranchId, name) {
      const [row] = await db
        .select()
        .from(machineAgentTerminals)
        .where(
          and(eq(machineAgentTerminals.machineBranchId, machineBranchId), eq(machineAgentTerminals.name, name)),
        )
        .limit(1);
      return row ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(machineAgentTerminals)
        .values({
          ownerId: input.ownerId,
          machineBranchId: input.machineBranchId,
          name: input.name,
          agentType: input.agentType,
          streamSessionId: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row;
    },

    async updateStreamSessionId({ id, streamSessionId, now }) {
      await db
        .update(machineAgentTerminals)
        .set({ streamSessionId, updatedAt: now })
        .where(eq(machineAgentTerminals.id, id));
    },

    async remove(machineBranchId, name) {
      await db
        .delete(machineAgentTerminals)
        .where(
          and(eq(machineAgentTerminals.machineBranchId, machineBranchId), eq(machineAgentTerminals.name, name)),
        );
    },
  };
}
