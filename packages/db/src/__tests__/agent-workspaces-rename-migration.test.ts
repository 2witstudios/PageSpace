/**
 * The `agent_sessions` → `agent_workspaces` rename (0254, epic Phase 5).
 *
 * Two classes of assertion, and both matter for different reasons.
 *
 * STATIC — the migration text. A rename migration is one careless
 * `drizzle-kit generate` away from becoming a DROP TABLE + CREATE TABLE, which
 * is what drizzle emits non-interactively when it cannot ask whether a
 * dropped/created pair is a rename. That shape would be catastrophic twice
 * over: it destroys every row, and every `agent_workspaces.id` it re-mints is
 * the HMAC fold input for a live Sprite's name
 * (`deriveAgentSessionSpriteKey`), so every running VM would be orphaned and
 * every persistent filesystem stranded. These tests refuse the shape.
 *
 * LIVE — the reclaim trigger. `agent_sessions_sprite_reclaim` (0233/0238) is
 * an AFTER DELETE trigger that moves a still-live Sprite pointer into the
 * `machine_sprite_reclaims` outbox inside the deleting transaction. It is the
 * last pointer to a VM whose row is disappearing via a drive cascade, an owner
 * cascade (GDPR Art. 17 erasure), or a direct end. `ALTER TABLE ... RENAME`
 * carries triggers; `DROP TABLE` does not. Asserting the trigger merely EXISTS
 * would pass against a trigger whose function had been renamed out from under
 * it, so this deletes a real row and asserts the outbox row appears.
 *
 * Requires DATABASE_URL (CI's `test:coverage` job provides it, against the
 * migrated test database). It fails loudly rather than skipping: a silently
 * skipped trigger test has already hidden a real failure in this repo once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => /^0254_.*\.sql$/.test(f));
const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match the prose header. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle/0254 agent_workspaces rename — migration text', () => {
  it('should exist in the journal as migration 0254', () => {
    expect(migrationFile).toBeDefined();
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 254)?.tag).toBe(
      path.basename(migrationFile ?? '', '.sql'),
    );
  });

  it('should rename both tables', () => {
    expect(code).toContain('ALTER TABLE "agent_sessions" RENAME TO "agent_workspaces"');
    expect(code).toContain('ALTER TABLE "agent_session_shells" RENAME TO "agent_workspace_shells"');
  });

  it('should rename every column in the inventory', () => {
    expect(code).toContain('ALTER TABLE "agent_workspaces" RENAME COLUMN "sessionKey" TO "spriteKey"');
    expect(code).toContain('ALTER TABLE "agent_workspace_shells" RENAME COLUMN "sessionId" TO "workspaceId"');
    expect(code).toContain('ALTER TABLE "agent_workspace_shells" RENAME COLUMN "streamSessionId" TO "spriteExecId"');
    expect(code).toContain('ALTER TABLE "conversations" RENAME COLUMN "sessionId" TO "workspaceId"');
    expect(code).toContain('ALTER TABLE "conversations" RENAME COLUMN "closedInSessionAt" TO "closedInWorkspaceAt"');
  });

  /**
   * THE assertion this file exists for. Every id value must survive verbatim:
   * they are the Sprite-key fold input, so a rewritten id orphans a live VM.
   */
  it('should destroy nothing — no DROP TABLE, no DELETE, no id rewrite', () => {
    expect(code).not.toMatch(/DROP TABLE/i);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/TRUNCATE/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    // The only UPDATEs a rename may contain are none at all; an id rewrite
    // would have to be one.
    expect(code).not.toMatch(/\bUPDATE\s+"?agent_/i);
    expect(code).not.toMatch(/SET\s+"?id"?\s*=/i);
  });

  it('should leave the Sprite-key namespace alone (the fold input, not just the id)', () => {
    const keySource = readFileSync(
      path.resolve(__dirname, '../../../lib/src/agent-workspaces/workspace-sprite-key.ts'),
      'utf8',
    );
    // Bumping either of these re-derives every Sprite name from the same ids —
    // the same orphaning failure as rewriting the ids themselves.
    expect(keySource).toContain("const NAMESPACE_VERSION = 'agent-session-sprite:v2'");
    expect(keySource).toContain('return `pgs-ses-${digest}`');
  });

  it('should rename the reclaim trigger and its function rather than recreating them', () => {
    expect(code).toContain('ALTER FUNCTION agent_sessions_capture_sprite_reclaim() RENAME TO agent_workspaces_capture_sprite_reclaim');
    expect(code).toContain('ALTER TRIGGER agent_sessions_sprite_reclaim ON "agent_workspaces" RENAME TO agent_workspaces_sprite_reclaim');
    // A dropped-and-recreated trigger is a window in which a delete slips
    // through unrecorded. There must be no DROP of either object.
    expect(code).not.toMatch(/DROP\s+TRIGGER/i);
    expect(code).not.toMatch(/DROP\s+FUNCTION/i);
    expect(code).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i);
  });

  it('should rename indexes and constraints explicitly (Postgres does not cascade these)', () => {
    for (const stmt of [
      'ALTER INDEX "agent_sessions_pkey" RENAME TO "agent_workspaces_pkey"',
      'ALTER INDEX "conversations_session_id_idx" RENAME TO "conversations_workspace_id_idx"',
      'ALTER INDEX "agent_session_shells_session_name_idx" RENAME TO "agent_workspace_shells_workspace_name_idx"',
      'RENAME CONSTRAINT "conversations_sessionId_agent_sessions_id_fk" TO "conversations_workspaceId_agent_workspaces_id_fk"',
      'RENAME CONSTRAINT "agent_workspace_layout_ops_workspaceId_agent_sessions_id_fk" TO "agent_workspace_layout_ops_workspaceId_agent_workspaces_id_fk"',
      'RENAME CONSTRAINT "agent_workspace_layout_revs_workspaceId_agent_sessions_id_fk" TO "agent_workspace_layout_revs_workspaceId_agent_workspaces_id_fk"',
      'RENAME CONSTRAINT "agent_workspace_pane_columns_workspaceId_agent_sessions_id_fk" TO "agent_workspace_pane_columns_workspaceId_agent_workspaces_id_fk"',
    ]) {
      expect(code).toContain(stmt);
    }
    // A dropped-and-re-added FK revalidates the whole table under ACCESS
    // EXCLUSIVE for a pure naming change.
    expect(code).not.toMatch(/DROP\s+CONSTRAINT/i);
  });

  it('should ship the one-release compat views under the OLD table names', () => {
    expect(code).toContain('CREATE OR REPLACE VIEW "agent_sessions"');
    expect(code).toContain('CREATE OR REPLACE VIEW "agent_session_shells"');
    // The views must expose the OLD column spellings — that is their entire job.
    expect(code).toContain('"spriteKey" AS "sessionKey"');
    expect(code).toContain('"workspaceId" AS "sessionId"');
    expect(code).toContain('"spriteExecId" AS "streamSessionId"');
    // And they must announce their own expiry, so the contract PR can find them.
    expect(code).toMatch(/COMMENT ON VIEW "agent_sessions" IS '.*COMPAT SHIM/);
    expect(code).toMatch(/COMMENT ON VIEW "agent_session_shells" IS '.*COMPAT SHIM/);
  });
});

describe('drizzle/0254 agent_workspaces rename — live schema', () => {
  const url = process.env.DATABASE_URL;
  let client: Client;

  beforeAll(async () => {
    if (!url) {
      throw new Error(
        'agent-workspaces-rename-migration.test.ts requires DATABASE_URL pointed at a migrated database. ' +
          'It is not skippable: the reclaim trigger is the GDPR erasure path and a silent skip proves nothing.',
      );
    }
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('should have the renamed tables and not the old ones as TABLES', async () => {
    const { rows } = await client.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('agent_sessions','agent_workspaces','agent_session_shells','agent_workspace_shells')
       ORDER BY table_name`,
    );
    const byName = new Map(rows.map((r) => [r.table_name, r.table_type]));
    expect(byName.get('agent_workspaces')).toBe('BASE TABLE');
    expect(byName.get('agent_workspace_shells')).toBe('BASE TABLE');
    // The old names survive ONLY as the compat views.
    expect(byName.get('agent_sessions')).toBe('VIEW');
    expect(byName.get('agent_session_shells')).toBe('VIEW');
  });

  it('should carry the reclaim trigger onto agent_workspaces', async () => {
    const { rows } = await client.query<{ tgname: string; proname: string; tgenabled: string }>(
      `SELECT t.tgname, p.proname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'agent_workspaces'::regclass AND NOT t.tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgname).toBe('agent_workspaces_sprite_reclaim');
    expect(rows[0].proname).toBe('agent_workspaces_capture_sprite_reclaim');
    // 'O' = enabled for origin+local. A disabled trigger is a silent data loss.
    expect(rows[0].tgenabled).toBe('O');
  });

  /**
   * Presence is not function. This deletes a workspace row that still points at
   * a live Sprite and asserts the pointer lands in the outbox — the exact path
   * an Art. 17 erasure takes through the owner cascade.
   */
  it('should still MOVE a live Sprite pointer into the outbox on delete', async () => {
    const suffix = `rename-trigger-${Date.now()}`;
    const userId = `u-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    const sandboxId = `pgs-ses-${suffix}`;

    try {
      await client.query(
        `INSERT INTO users (id, name, email) VALUES ($1, 'rename trigger probe', $2)`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [workspaceId, userId, sandboxId, 'inst-1'],
      );

      // Deleting the OWNER is the GDPR path: the FK cascade reaches the
      // workspace row, and the trigger must fire inside that transaction.
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

      const { rows } = await client.query<{ sandboxId: string; spriteInstanceId: string | null }>(
        `SELECT "sandboxId", "spriteInstanceId" FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].spriteInstanceId).toBe('inst-1');
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('should NOT record a reclaim for a workspace whose Sprite is already torn down', async () => {
    const suffix = `rename-trigger-torn-${Date.now()}`;
    const userId = `u-${suffix}`;
    const sandboxId = `pgs-ses-${suffix}`;
    try {
      await client.query(
        `INSERT INTO users (id, name, email) VALUES ($1, 'rename trigger probe', $2)`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "sandboxId", "spriteTornDownAt", "updatedAt")
         VALUES ($1, $2, $3, now(), now())`,
        [`ws-${suffix}`, userId, sandboxId],
      );
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      const { rows } = await client.query(
        `SELECT 1 FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  /** The compat views are the rolling-deploy contract: readable AND writable. */
  it('should serve the old column names through the compat views, and accept writes', async () => {
    const suffix = `rename-view-${Date.now()}`;
    const userId = `u-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    try {
      await client.query(
        `INSERT INTO users (id, name, email) VALUES ($1, 'rename view probe', $2)`,
        [userId, `${suffix}@example.test`],
      );
      // A PRE-RENAME instance writing through the old name.
      await client.query(
        `INSERT INTO agent_sessions (id, "ownerId", "sessionKey", "updatedAt") VALUES ($1, $2, $3, now())`,
        [workspaceId, userId, 'pgs-ses-legacy'],
      );
      const base = await client.query<{ spriteKey: string | null }>(
        `SELECT "spriteKey" FROM agent_workspaces WHERE id = $1`,
        [workspaceId],
      );
      expect(base.rows[0].spriteKey).toBe('pgs-ses-legacy');

      // …and reading it back under the old column name.
      const view = await client.query<{ sessionKey: string | null }>(
        `SELECT "sessionKey" FROM agent_sessions WHERE id = $1`,
        [workspaceId],
      );
      expect(view.rows[0].sessionKey).toBe('pgs-ses-legacy');

      // Shells, same deal, including the exec-stream column.
      await client.query(
        `INSERT INTO agent_session_shells (id, "sessionId", "ownerId", name, "agentType", "streamSessionId", "updatedAt")
         VALUES ($1, $2, $3, 'tab-1', 'shell', 'exec-9', now())`,
        [`sh-${suffix}`, workspaceId, userId],
      );
      const shell = await client.query<{ workspaceId: string; spriteExecId: string | null }>(
        `SELECT "workspaceId", "spriteExecId" FROM agent_workspace_shells WHERE id = $1`,
        [`sh-${suffix}`],
      );
      expect(shell.rows[0].workspaceId).toBe(workspaceId);
      expect(shell.rows[0].spriteExecId).toBe('exec-9');
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});
