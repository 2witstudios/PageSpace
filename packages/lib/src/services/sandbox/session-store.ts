/**
 * Sandbox session store — the sandboxId↔conversation link (IO).
 *
 * Wraps the `sandbox_sessions` table behind a small interface so the lifecycle
 * orchestrator (`session-manager`) can be unit-tested against an in-memory fake
 * rather than a database. The Drizzle-backed implementation is constructed by
 * `createDbSandboxSessionStore`, which lazily imports the db module so unit
 * tests that inject a fake never load the DB module graph (matching the PR1
 * `can-run-code` / `quota` / `audit` pattern).
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

/**
 * Production store. Lazily resolves the db client, schema table, and `eq`
 * operator so this module imposes no DB import on callers that inject a fake.
 * The queries below are type-checked against the real Drizzle types.
 */
export async function createDbSandboxSessionStore(): Promise<SandboxSessionStore> {
  const [{ db }, { eq }, { sandboxSessions }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/sandbox-sessions'),
  ]);

  return {
    async findBySessionKey(sessionKey) {
      const [row] = await db
        .select()
        .from(sandboxSessions)
        .where(eq(sandboxSessions.sessionKey, sessionKey))
        .limit(1);
      if (!row) return null;
      return {
        sessionKey: row.sessionKey,
        conversationId: row.conversationId,
        driveId: row.driveId,
        tenantId: row.tenantId,
        userId: row.userId,
        sandboxId: row.sandboxId,
        lastActiveAt: row.lastActiveAt,
      };
    },

    async save({ sessionKey, conversationId, driveId, tenantId, userId, sandboxId, now }) {
      await db
        .insert(sandboxSessions)
        .values({
          sessionKey,
          conversationId,
          driveId: driveId ?? null,
          tenantId: tenantId ?? null,
          userId,
          sandboxId,
          lastActiveAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sandboxSessions.sessionKey,
          set: { sandboxId, lastActiveAt: now, updatedAt: now },
        });
    },

    async touch({ sessionKey, now }) {
      await db
        .update(sandboxSessions)
        .set({ lastActiveAt: now, updatedAt: now })
        .where(eq(sandboxSessions.sessionKey, sessionKey));
    },

    async remove(sessionKey) {
      await db.delete(sandboxSessions).where(eq(sandboxSessions.sessionKey, sessionKey));
    },
  };
}
