/**
 * Sandbox session store — the sandboxId↔conversation link (IO).
 *
 * Wraps the `sandbox_sessions` table behind a small interface so the lifecycle
 * orchestrator (`session-manager`) can be unit-tested against an in-memory fake
 * rather than a database. The Drizzle-backed implementation is constructed by
 * `createDbSandboxSessionStore`, which lazily imports the db module so unit
 * tests that inject a fake never load the DB module graph.
 *
 * A row's presence means "this conversation has a sandbox we believe is live".
 * `save` is an upsert keyed by the unique session key: re-provisioning a vanished
 * sandbox under the same conversation overwrites the stale `sandboxId` rather
 * than colliding on the unique constraint.
 */

export interface SandboxSessionRecord {
  sessionKey: string;
  conversationId: string;
  driveId: string | null;
  tenantId: string | null;
  userId: string;
  sandboxId: string;
  lastActiveAt: Date;
}

export interface SaveSandboxSessionInput {
  sessionKey: string;
  conversationId: string;
  driveId?: string | null;
  tenantId?: string | null;
  userId: string;
  sandboxId: string;
  now: Date;
}

export interface SandboxSessionStore {
  findBySessionKey(sessionKey: string): Promise<SandboxSessionRecord | null>;
  save(input: SaveSandboxSessionInput): Promise<void>;
  touch(args: { sessionKey: string; now: Date }): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

// IO seam, injected so the Drizzle queries can be swapped for an in-memory fake.
// Typed against the structural shape we use rather than the concrete db client,
// keeping this module free of a hard db import at the type level.
export interface SandboxSessionStoreDb {
  insert: (table: unknown) => {
    values: (row: Record<string, unknown>) => {
      onConflictDoUpdate: (args: { target: unknown; set: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  select: () => {
    from: (table: unknown) => {
      where: (cond: unknown) => {
        limit: (n: number) => Promise<Array<Record<string, unknown>>>;
      };
    };
  };
  update: (table: unknown) => {
    set: (row: Record<string, unknown>) => { where: (cond: unknown) => Promise<unknown> };
  };
  delete: (table: unknown) => { where: (cond: unknown) => Promise<unknown> };
}

interface DbStoreDeps {
  db: SandboxSessionStoreDb;
  table: { sessionKey: unknown; sandboxId: unknown; lastActiveAt: unknown };
  eq: (a: unknown, b: unknown) => unknown;
}

function rowToRecord(row: Record<string, unknown>): SandboxSessionRecord {
  return {
    sessionKey: row.sessionKey as string,
    conversationId: row.conversationId as string,
    driveId: (row.driveId as string | null) ?? null,
    tenantId: (row.tenantId as string | null) ?? null,
    userId: row.userId as string,
    sandboxId: row.sandboxId as string,
    lastActiveAt: row.lastActiveAt as Date,
  };
}

/**
 * Build a store over the injected db/table/operators. Exposed for the DB-backed
 * integration test; production callers use `createDbSandboxSessionStore`.
 */
export function makeSandboxSessionStore({ db, table, eq }: DbStoreDeps): SandboxSessionStore {
  return {
    async findBySessionKey(sessionKey) {
      const rows = await db.select().from(table).where(eq(table.sessionKey, sessionKey)).limit(1);
      const row = rows[0];
      return row ? rowToRecord(row) : null;
    },
    async save(input) {
      const row = {
        sessionKey: input.sessionKey,
        conversationId: input.conversationId,
        driveId: input.driveId ?? null,
        tenantId: input.tenantId ?? null,
        userId: input.userId,
        sandboxId: input.sandboxId,
        lastActiveAt: input.now,
        updatedAt: input.now,
      };
      await db
        .insert(table)
        .values(row)
        .onConflictDoUpdate({
          target: table.sessionKey,
          set: { sandboxId: input.sandboxId, lastActiveAt: input.now, updatedAt: input.now },
        });
    },
    async touch({ sessionKey, now }) {
      await db
        .update(table)
        .set({ lastActiveAt: now, updatedAt: now })
        .where(eq(table.sessionKey, sessionKey));
    },
    async remove(sessionKey) {
      await db.delete(table).where(eq(table.sessionKey, sessionKey));
    },
  };
}

/**
 * Production store. Lazily resolves the db client, schema table, and `eq`
 * operator so this module imposes no DB import on callers that inject a fake.
 */
export async function createDbSandboxSessionStore(): Promise<SandboxSessionStore> {
  const [{ db }, { eq }, { sandboxSessions }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/sandbox-sessions'),
  ]);
  return makeSandboxSessionStore({
    db: db as unknown as SandboxSessionStoreDb,
    table: sandboxSessions as unknown as DbStoreDeps['table'],
    eq,
  });
}
