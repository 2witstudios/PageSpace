/**
 * Machine Projects store (IO, dependency-injected).
 *
 * DB-backed CRUD for the `machine_projects` table — the durable record of
 * which git repos are cloned onto a Machine's persistent filesystem. A
 * Machine's identity is its backing page (`machineId`) — the same page whose
 * persistent Sprite session (`terminal_sessions`) a live Terminal shell or a
 * page-agent's "own machine" tool calls already reconnect to. Kept separate
 * from the clone/remove orchestration (machine-projects.ts) so that
 * orchestration logic is testable against an in-memory fake without a real
 * database.
 */

import { isUniqueViolation } from '../subdomain-allocation';

export interface MachineProjectRecord {
  id: string;
  ownerId: string;
  machineId: string;
  name: string;
  repoUrl: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMachineProjectInput {
  ownerId: string;
  machineId: string;
  name: string;
  repoUrl: string;
  path: string;
  now: Date;
}

export interface MachineProjectStore {
  list(machineId: string): Promise<MachineProjectRecord[]>;
  findByName(machineId: string, name: string): Promise<MachineProjectRecord | null>;
  /** Throws a unique-violation error (see `isUniqueViolation`) if `name` already exists on this machine. */
  create(input: NewMachineProjectInput): Promise<MachineProjectRecord>;
  remove(machineId: string, name: string): Promise<void>;
}

/** Re-exported so callers can classify a `create` rejection without importing the DB layer directly. */
export { isUniqueViolation };

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * table, and operators so callers that inject a fake (in tests) never load
 * the DB module graph.
 */
export async function createDbMachineProjectStore(): Promise<MachineProjectStore> {
  const [{ db }, { eq, and }, { machineProjects }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-projects'),
  ]);

  return {
    async list(machineId) {
      const rows = await db
        .select()
        .from(machineProjects)
        .where(eq(machineProjects.machineId, machineId));
      return rows;
    },

    async findByName(machineId, name) {
      const [row] = await db
        .select()
        .from(machineProjects)
        .where(and(eq(machineProjects.machineId, machineId), eq(machineProjects.name, name)))
        .limit(1);
      return row ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(machineProjects)
        .values({
          ownerId: input.ownerId,
          machineId: input.machineId,
          name: input.name,
          repoUrl: input.repoUrl,
          path: input.path,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row;
    },

    async remove(machineId, name) {
      await db
        .delete(machineProjects)
        .where(and(eq(machineProjects.machineId, machineId), eq(machineProjects.name, name)));
    },
  };
}
