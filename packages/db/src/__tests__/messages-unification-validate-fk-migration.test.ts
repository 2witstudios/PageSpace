/**
 * Migration 0250 (messages-unification VALIDATE) — epic "Agent-Session Single
 * Source of Truth", Phase 4 PR 14, the soak gate
 * (docs/2.0-architecture/agent-sessions.md; plan D6).
 *
 * 0248 added `chat_messages.conversationId`'s FK `NOT VALID`: enforced for new
 * rows, the legacy corpus left unscanned. 0250 scans it. The value of that is
 * not the constraint — the table is dropped at PR 15 — it is the RECEIPT: a
 * legacy row whose conversation does not exist is a row `messages` could never
 * have accepted (its own FK is validated and cascading), so a passing VALIDATE
 * is the proof that the copy PR 15 keeps is not missing anything the original
 * held.
 *
 * Two layers, matching the 0248/0249 suite next door:
 *
 *   1. STATIC invariants of the SQL, which run with no database at all.
 *   2. LIVE behavior against a real Postgres whenever DATABASE_URL is set.
 *      A database is migrated to 0249 and kept as a TEMPLATE; each scenario
 *      gets its own copy, seeds a corpus, and watches 0250 actually run. The
 *      app's own database is never touched.
 *
 * The three behaviours pinned live are the three the PR promises: it validates
 * cleanly on a healthy corpus, it FAILS LOUDLY (naming the rows) when one
 * violates the FK rather than letting VALIDATE emit an opaque 23503, and a
 * re-run of the whole block is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations, type RunnableMigration } from '../migration-runner';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const FK = 'chat_messages_conversationId_conversations_id_fk';

function readMigration(idx: number): { file: string; sql: string; code: string } {
  const prefix = String(idx).padStart(4, '0');
  const file = readdirSync(MIGRATIONS_DIR).find((f) => new RegExp(`^${prefix}_.*\\.sql$`).test(f));
  if (!file) throw new Error(`no migration ${prefix}_*.sql`);
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Line comments stripped, so assertions never match prose.
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return { file, sql, code };
}

const validate = readMigration(250);

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };

describe('drizzle/0250 messages unification — validate the FK', () => {
  it('should be migration 0250 in the journal', () => {
    expect(journal.entries.find((e) => e.idx === 250)?.tag).toBe(
      path.basename(validate.file, '.sql'),
    );
  });

  it('should validate the constraint 0248 added, by its exact name', () => {
    expect(validate.code).toContain(`ALTER TABLE "chat_messages" VALIDATE CONSTRAINT "${FK}"`);
    // The name is not guessable — it must be the one 0248 wrote.
    expect(readMigration(248).code).toContain(`ADD CONSTRAINT "${FK}"`);
  });

  it('should be idempotent by gating on convalidated, not on a re-run failing', () => {
    expect(validate.code).toContain('convalidated');
    expect(validate.code).toContain('FROM pg_constraint');
    // The gate must come BEFORE the validation it guards.
    expect(validate.code.indexOf('convalidated')).toBeLessThan(
      validate.code.indexOf('VALIDATE CONSTRAINT'),
    );
  });

  it('should AUDIT for FK violations before validating, and raise with the ids', () => {
    const auditAt = validate.code.indexOf('LEFT JOIN "conversations"');
    const validateAt = validate.code.indexOf('VALIDATE CONSTRAINT');
    expect(auditAt).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(auditAt);
    expect(validate.code).toContain('RAISE EXCEPTION');
    // Counted AND named: a migration that fails without naming the rows to
    // repair is a dead end.
    expect(validate.code).toContain('string_agg');
  });

  it('should report the page-mismatched conversations without blocking on them', () => {
    expect(validate.code).toMatch(/c\."contextId" IS DISTINCT FROM cm\."pageId"/);
    expect(validate.code).toContain('RAISE WARNING');
  });

  it('should never repair or destroy rows — it audits, reports, and validates', () => {
    expect(validate.code).not.toMatch(/^\s*(UPDATE|DELETE FROM|TRUNCATE|INSERT INTO)\b/m);
    expect(validate.code).not.toContain('DROP TABLE');
    expect(validate.code).not.toContain('DROP COLUMN');
  });
});

// ───────────────────────────── live behavior ──────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

/** All migrations, in journal order. Index N === journal idx N. */
const allMigrations: RunnableMigration[] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** Everything BEFORE this PR's migration. */
const baseMigrations = allMigrations.slice(0, 250);

/** Every message on an error's cause chain — drizzle wraps driver errors. */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join('\n');
}

function urlForDatabase(name: string): string {
  const parsed = new URL(DATABASE_URL as string);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

const suffix = `${process.pid}_${Date.now().toString(36)}`;
const TEMPLATE_DB = `psx_validate_tmpl_${suffix}`;
const createdDatabases: string[] = [];

let adminPool: Pool;

/** A scratch database seeded to 0249, plus the notices its migrations emitted. */
interface Scenario {
  pool: Pool;
  notices: string[];
  /** Applies 0250. Resolves to the error when the migration aborts. */
  migrate: () => Promise<Error | null>;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<T[]>;
}

async function openScenario(name: string): Promise<Scenario> {
  const dbName = `psx_validate_${name}_${suffix}`;
  await adminPool.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
  createdDatabases.push(dbName);

  const notices: string[] = [];
  const pool = new Pool({ connectionString: urlForDatabase(dbName), max: 1 });
  pool.on('connect', (client) => {
    client.on('notice', (n) => notices.push(`${n.severity}: ${n.message ?? ''}`));
  });

  return {
    pool,
    notices,
    migrate: async () => {
      try {
        await runMigrations(drizzle(pool), allMigrations, {
          migrationsSchema: 'drizzle',
          migrationsTable: '__drizzle_migrations',
        });
        return null;
      } catch (err) {
        return err as Error;
      }
    },
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => (await pool.query(text, values)).rows as T[],
  };
}

/** Users, a drive and pages every scenario builds its corpus on. */
async function seedFixtures(s: Scenario): Promise<void> {
  await s.query(`
    INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES
      ('u_owner', 'Owner', 'owner@example.com', now(), now());

    INSERT INTO "drives" ("id", "name", "slug", "ownerId", "createdAt", "updatedAt") VALUES
      ('d_main', 'Main', 'main', 'u_owner', now(), now());

    INSERT INTO "pages" ("id", "title", "type", "position", "driveId", "createdBy", "createdAt", "updatedAt") VALUES
      ('p_one', 'One', 'AI_CHAT', 1, 'd_main', 'u_owner', now(), now()),
      ('p_two', 'Two', 'AI_CHAT', 2, 'd_main', 'u_owner', now(), now());
  `);
}

/** Whether the FK is present and validated. */
async function fkState(s: Scenario): Promise<Array<{ convalidated: boolean }>> {
  return s.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = '${FK}'`,
  );
}

/**
 * Seeds a row that VIOLATES the FK. It has to drop the constraint to do it —
 * which is the point: since 0248 the ONLY way such a row can exist is to have
 * predated the constraint, exactly like the orphans 0248 could not give a
 * parent to.
 */
async function seedOrphanRows(s: Scenario, conversationId: string, ids: string[]): Promise<void> {
  await s.query(`ALTER TABLE "chat_messages" DROP CONSTRAINT "${FK}"`);
  for (const id of ids) {
    await s.query(
      `INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt")
       VALUES ($1, 'p_one', $2, 'user', 'hi', now())`,
      [id, conversationId],
    );
  }
  await s.query(`
    ALTER TABLE "chat_messages" ADD CONSTRAINT "${FK}"
      FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id")
      ON DELETE cascade ON UPDATE no action NOT VALID
  `);
}

describeLive('0250 against a real Postgres', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    createdDatabases.push(TEMPLATE_DB);

    // Migrate the template to 0249 — the schema as it stands BEFORE this PR —
    // then disconnect, because a template with open connections cannot be
    // copied.
    const templatePool = new Pool({ connectionString: urlForDatabase(TEMPLATE_DB), max: 1 });
    try {
      await runMigrations(drizzle(templatePool), baseMigrations, {
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations',
      });
    } finally {
      await templatePool.end();
    }
  }, 600_000);

  afterAll(async () => {
    if (!adminPool) return;
    for (const name of [...createdDatabases].reverse()) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await adminPool.end();
  }, 120_000);

  it('pins the base: 0250 is the only migration under test here', () => {
    expect(allMigrations.length - baseMigrations.length).toBe(1);
    expect(journal.entries[250]?.idx).toBe(250);
  });

  it('leaves the constraint NOT VALID until this migration runs', async () => {
    const s = await openScenario('preflight');
    try {
      expect(await fkState(s)).toEqual([{ convalidated: false }]);
    } finally {
      await s.pool.end();
    }
  }, 120_000);

  it('validates cleanly on a healthy corpus, and re-running the block is a no-op', async () => {
    const s = await openScenario('healthy');
    try {
      await seedFixtures(s);
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "createdAt", "updatedAt")
        VALUES ('c_live', 'u_owner', 'page', 'p_one', now(), now());
      `);
      await s.query(`
        INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt")
        VALUES ('m1', 'p_one', 'c_live', 'user', 'hi', now()),
               ('m2', 'p_one', 'c_live', 'assistant', 'hello', now());
      `);

      expect(await s.migrate()).toBeNull();
      expect(await fkState(s)).toEqual([{ convalidated: true }]);
      expect(s.notices.join('\n')).toMatch(/0 orphan conversations/);

      // Nothing was repaired or removed on the way through.
      expect(await s.query(`SELECT 1 FROM "chat_messages"`)).toHaveLength(2);
      expect(await s.query(`SELECT 1 FROM "conversations"`)).toHaveLength(1);

      // IDEMPOTENT: replaying the whole block on an already-validated database
      // does nothing and says so. (The journal hash is what stops a migration
      // running twice in production; this is what must survive a partial run
      // being retried, or an operator re-applying by hand.)
      const before = s.notices.length;
      const client = await s.pool.connect();
      try {
        await client.query(validate.sql);
      } finally {
        client.release();
      }
      expect(s.notices.slice(before).join('\n')).toMatch(/already validated/);
      expect(await fkState(s)).toEqual([{ convalidated: true }]);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('fails loudly — naming the conversation and the row count — on a violating row', async () => {
    const s = await openScenario('violating');
    try {
      await seedFixtures(s);
      await seedOrphanRows(s, 'c_no_parent', ['m_orphan_a', 'm_orphan_b']);

      const reported = errorChain(await s.migrate());
      // The count, the blast radius, and the id — everything a repair needs.
      expect(reported).toMatch(/1 conversation id\(s\), covering 2 message row\(s\)/);
      expect(reported).toContain('c_no_parent');
      // It names its provenance (0248's skipped orphans) and both repair
      // options, rather than leaving an opaque 23503 from VALIDATE itself.
      expect(reported).toMatch(/0248/);
      expect(reported).not.toMatch(/violates foreign key constraint/);

      // The migration rolled back: the constraint is untouched, and — the
      // point of failing in the audit rather than in VALIDATE — the rows are
      // all still there to repair.
      expect(await fkState(s)).toEqual([{ convalidated: false }]);
      expect(await s.query(`SELECT 1 FROM "chat_messages"`)).toHaveLength(2);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('reports page-mismatched conversations at WARNING and validates anyway', async () => {
    const s = await openScenario('mismatch');
    try {
      await seedFixtures(s);
      // The conversation says page two; its legacy messages say page one.
      // A real parent exists, so the FK is satisfied — this is a READER
      // problem (every reader derives the page from contextId now), which is
      // why it is reported and not raised.
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "createdAt", "updatedAt")
        VALUES ('c_mismatch', 'u_owner', 'page', 'p_two', now(), now());
      `);
      await s.query(`
        INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt")
        VALUES ('m_mismatch', 'p_one', 'c_mismatch', 'user', 'hi', now());
      `);

      expect(await s.migrate()).toBeNull();
      expect(await fkState(s)).toEqual([{ convalidated: true }]);

      const notices = s.notices.join('\n');
      expect(notices).toMatch(/WARNING/);
      expect(notices).toMatch(/disagree with their chat_messages about the page/);
      expect(notices).toContain('c_mismatch');
      expect(notices).toMatch(/1 page-mismatched conversation/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('refuses to run at all if the constraint was dropped by hand', async () => {
    const s = await openScenario('missingfk');
    try {
      await s.query(`ALTER TABLE "chat_messages" DROP CONSTRAINT "${FK}"`);

      const reported = errorChain(await s.migrate());
      // Silently re-adding it would be worse: 0248's ON DELETE CASCADE is
      // load-bearing for the retention purge, and a re-add here could differ.
      expect(reported).toMatch(/does not exist/);
      expect(reported).toMatch(/0248/);
      expect(await fkState(s)).toHaveLength(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('keeps the validated FK cascading, so retention can still delete a conversation', async () => {
    const s = await openScenario('cascade');
    try {
      await seedFixtures(s);
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "createdAt", "updatedAt")
        VALUES ('c_live', 'u_owner', 'page', 'p_one', now(), now());
      `);
      await s.query(`
        INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt")
        VALUES ('m1', 'p_one', 'c_live', 'user', 'hi', now());
      `);

      expect(await s.migrate()).toBeNull();

      // VALIDATE must not have replaced the constraint with a different one.
      await s.query(`DELETE FROM "conversations" WHERE "id" = 'c_live'`);
      expect(await s.query(`SELECT 1 FROM "chat_messages"`)).toHaveLength(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);
});
