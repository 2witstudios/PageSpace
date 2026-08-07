/**
 * Migration 0253 (DROP chat_messages) — epic "Agent-Session Single Source of
 * Truth", Phase 4 PR 15, the contract step and the ONLY irreversible migration
 * in the epic (docs/2.0-architecture/agent-sessions.md §3a; plan D6).
 *
 * What it has to get right, and therefore what is pinned here:
 *
 *   1. On a HEALTHY corpus it drops cleanly — table gone, `messages."pageId"`
 *      gone, and every message still readable through its conversation.
 *   2. A STRAGGLER — a legacy row with no unified twin, the shape a
 *      version-skipping tenant/onprem operator arrives with because nobody
 *      ran `scripts/backfill-unify-messages.ts` there — is RESCUED by the
 *      in-migration sweep rather than lost.
 *   3. An UNTWINNABLE row — one whose conversation does not exist, so the FK
 *      refuses the copy — makes the migration RAISE, with counts and ids, and
 *      the table survives. Refusing to drop is the whole point: this is the
 *      one step with no code-level rollback.
 *   4. `type='client'` threads come out with a real page link
 *      (`conversations."agentPageId"`), because dropping `messages."pageId"`
 *      without one would 404 `POST /api/v1/chat/completions` thread mode and
 *      pagespace-cli's edit/delete.
 *   5. Re-running the whole block is a no-op.
 *
 * Two layers, matching the 0249/0250/0251 suites next door:
 *
 *   1. STATIC invariants of the SQL, which run with no database at all.
 *   2. LIVE behavior against a real Postgres whenever DATABASE_URL is set. A
 *      database is migrated to 0252 and kept as a TEMPLATE; each scenario gets
 *      its own copy, seeds a corpus, and watches 0253 actually run. The app's
 *      own database is never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations, type RunnableMigration } from '../migration-runner';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

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

const drop = readMigration(253);

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };

describe('drizzle/0253 — drop chat_messages', () => {
  it('should be migration 0253 in the journal', () => {
    expect(journal.entries.find((e) => e.idx === 253)?.tag).toBe(
      path.basename(drop.file, '.sql'),
    );
  });

  it('should DROP the legacy table and the transitional column', () => {
    expect(drop.code).toContain('DROP TABLE IF EXISTS "chat_messages"');
    expect(drop.code).toContain('ALTER TABLE "messages" DROP COLUMN IF EXISTS "pageId"');
  });

  it('should sweep, then guard, then drop — in that order', () => {
    const sweepAt = drop.code.indexOf('INSERT INTO "messages"');
    const guardAt = drop.code.indexOf('RAISE EXCEPTION');
    const dropTableAt = drop.code.indexOf('DROP TABLE IF EXISTS "chat_messages"');
    const dropColumnAt = drop.code.indexOf('ALTER TABLE "messages" DROP COLUMN');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(sweepAt);
    expect(dropTableAt).toBeGreaterThan(guardAt);
    expect(dropColumnAt).toBeGreaterThan(dropTableAt);
  });

  it('should give type=client threads their page link BEFORE dropping the column it comes from', () => {
    const addColumnAt = drop.code.indexOf('ADD COLUMN IF NOT EXISTS "agentPageId"');
    const backfillAt = drop.code.indexOf('SET "agentPageId" = src."pageId"');
    const dropColumnAt = drop.code.indexOf('ALTER TABLE "messages" DROP COLUMN');
    expect(addColumnAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(addColumnAt);
    expect(dropColumnAt).toBeGreaterThan(backfillAt);
  });

  it('should name the rows it refuses to drop on, not just count them', () => {
    expect(drop.code).toContain('string_agg');
    expect(drop.code).toContain('LIMIT 50');
    expect(drop.code).toContain('USING HINT');
  });

  it('should be idempotent: every block guarded, nothing unconditional', () => {
    expect(drop.code).toContain('ADD COLUMN IF NOT EXISTS');
    expect(drop.code).toContain('CREATE INDEX IF NOT EXISTS');
    expect(drop.code).toContain('DROP INDEX IF EXISTS');
    expect(drop.code).toContain('DROP COLUMN IF EXISTS');
    // The sweep, the stale-twin repair and the guard all read a table this
    // same migration drops; the client page-link backfill reads a COLUMN it
    // drops.
    expect(drop.code.match(/to_regclass\('public\.chat_messages'\) IS NULL/g)?.length).toBe(3);
    expect(drop.code).toMatch(/table_name = 'messages' AND column_name = 'pageId'/);
    expect(drop.code).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('should never DELETE from the legacy table — it copies, then drops wholesale', () => {
    expect(drop.code).not.toMatch(/DELETE\s+FROM\s+"?chat_messages/i);
    expect(drop.code).not.toMatch(/TRUNCATE/i);
  });
});

// ───────────────────────────── live behavior ──────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

/** All migrations, in journal order. */
const allMigrations: RunnableMigration[] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** Everything BEFORE 0253 (… 0252). */
const baseMigrations = allMigrations.slice(0, 253);
/**
 * Through 0253 and no further. Bounded by INDEX, not by `length - 1`: this
 * suite is about what 0253 does to a database, not about the head of the
 * journal, and the next migration to land must not silently join the scenario
 * (same fix as the 0251 suite's).
 */
const throughThisPr = allMigrations.slice(0, 254);

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
const TEMPLATE_DB = `psx_drop_tmpl_${suffix}`;
const createdDatabases: string[] = [];

let adminPool: Pool;

/** A scratch database seeded to 0252, plus the notices its migrations emitted. */
interface Scenario {
  pool: Pool;
  notices: string[];
  /** Applies 0253. Resolves to the error when the migration aborts. */
  migrate: () => Promise<Error | null>;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<T[]>;
}

async function openScenario(name: string): Promise<Scenario> {
  const dbName = `psx_drop_${name}_${suffix}`;
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
        await runMigrations(drizzle(pool), throughThisPr, {
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

/**
 * The state PR 14 left behind: page + client conversations whose rows live in
 * BOTH tables under the same ids, plus a global thread that only ever had
 * `messages`. `dualWrite` mirrors the production dual-write's column mapping.
 */
async function seedTwinnedCorpus(s: Scenario): Promise<void> {
  await s.query(`
    INSERT INTO "conversations" ("id", "userId", "type", "contextId", "isActive", "updatedAt") VALUES
      ('c_page',   'u_owner', 'page',   'p_one',  true, now()),
      ('c_client', 'u_owner', 'client', 'd_main', true, now()),
      ('c_global', 'u_owner', 'global', NULL,     true, now());
  `);
  await dualWrite(s, 'm_page_1', 'c_page', 'p_one', 'user', 'page question', 1);
  await dualWrite(s, 'm_page_2', 'c_page', 'p_one', 'assistant', 'page answer', 2);
  await dualWrite(s, 'm_client_1', 'c_client', 'p_two', 'user', 'api question', 3);
  await dualWrite(s, 'm_client_2', 'c_client', 'p_two', 'assistant', 'api answer', 4);
  await s.query(`
    INSERT INTO "messages" ("id", "conversationId", "userId", "role", "content", "createdAt", "isActive", "status")
    VALUES ('m_global_1', 'c_global', 'u_owner', 'user', 'global question', now(), true, 'complete');
  `);
}

async function dualWrite(
  s: Scenario,
  id: string,
  conversationId: string,
  pageId: string,
  role: string,
  content: string,
  order: number,
): Promise<void> {
  const createdAt = `now() - interval '${100 - order} minutes'`;
  await s.query(
    `INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt", "isActive")
     VALUES ($1, $2, $3, $4, $5, ${createdAt}, true)`,
    [id, pageId, conversationId, role, content],
  );
  await s.query(
    `INSERT INTO "messages" ("id", "conversationId", "userId", "role", "content", "createdAt", "isActive", "status", "pageId")
     VALUES ($1, $2, NULL, $3, $4, ${createdAt}, true, 'complete', $5)`,
    [id, conversationId, role, content, pageId],
  );
}

async function tableExists(s: Scenario, name: string): Promise<boolean> {
  const rows = await s.query<{ present: boolean }>(
    `SELECT to_regclass('public.${name}') IS NOT NULL AS present`,
  );
  return rows[0].present;
}

async function columnExists(s: Scenario, table: string, column: string): Promise<boolean> {
  const rows = await s.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0].n > 0;
}

describeLive('0253 against a real Postgres', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    createdDatabases.push(TEMPLATE_DB);

    // Migrate the template to 0252 — the schema as it stands BEFORE this PR —
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

  it('pins the base: 0253 is the only migration under test here', () => {
    expect(allMigrations.length).toBe(journal.entries.length);
    expect(throughThisPr.length - baseMigrations.length).toBe(1);
    expect(journal.entries[253]?.idx).toBe(253);
  });

  it('starts from a schema that still has both', async () => {
    const s = await openScenario('preflight');
    try {
      expect(await tableExists(s, 'chat_messages')).toBe(true);
      expect(await columnExists(s, 'messages', 'pageId')).toBe(true);
      expect(await columnExists(s, 'conversations', 'agentPageId')).toBe(false);
    } finally {
      await s.pool.end();
    }
  }, 120_000);

  it('drops cleanly on a healthy corpus, keeps every message, and is a no-op on re-run', async () => {
    const s = await openScenario('healthy');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);

      expect(await s.migrate()).toBeNull();

      expect(await tableExists(s, 'chat_messages')).toBe(false);
      expect(await columnExists(s, 'messages', 'pageId')).toBe(false);

      // Nothing lost: every id that existed on either leg is still readable,
      // and it is readable THROUGH ITS CONVERSATION, which is the whole claim
      // the drop rests on.
      const rows = await s.query<{ id: string; conversationId: string }>(
        `SELECT m."id", m."conversationId" FROM "messages" m ORDER BY m."id"`,
      );
      expect(rows.map((r) => r.id)).toEqual([
        'm_client_1', 'm_client_2', 'm_global_1', 'm_page_1', 'm_page_2',
      ]);

      expect(s.notices.join('\n')).toContain('completeness guard passed');

      // Re-running the block is a no-op — the guards short-circuit rather than
      // erroring on a table that is already gone.
      await s.query(readFileSync(path.join(MIGRATIONS_DIR, drop.file), 'utf8').split('--> statement-breakpoint').join(''));
      expect(await tableExists(s, 'chat_messages')).toBe(false);
      expect(await columnExists(s, 'messages', 'pageId')).toBe(false);
      expect(s.notices.join('\n')).toContain('already gone');
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('gives a type=client thread a real page link, derived from the rows it is about to lose', async () => {
    const s = await openScenario('clientlink');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);
      // A second client thread that named TWO agents across its life, and a
      // third that named a page which no longer exists.
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "isActive", "updatedAt") VALUES
          ('c_mixed', 'u_owner', 'client', 'd_main', true, now()),
          ('c_dead',  'u_owner', 'client', 'd_main', true, now());
        INSERT INTO "messages" ("id", "conversationId", "userId", "role", "content", "createdAt", "isActive", "status", "pageId") VALUES
          ('m_mixed_1', 'c_mixed', 'u_owner', 'user', 'first agent',  now() - interval '10 minutes', true, 'complete', 'p_one'),
          ('m_mixed_2', 'c_mixed', 'u_owner', 'user', 'second agent', now() - interval '5 minutes',  true, 'complete', 'p_two'),
          ('m_dead_1',  'c_dead',  'u_owner', 'user', 'gone',          now() - interval '5 minutes',  true, 'complete', 'p_deleted');
      `);

      expect(await s.migrate()).toBeNull();

      const rows = await s.query<{ id: string; agentPageId: string | null }>(
        `SELECT "id", "agentPageId" FROM "conversations" WHERE "type" = 'client' ORDER BY "id"`,
      );
      expect(rows).toEqual([
        // Named only a deleted page: page-less rather than dangling.
        { id: 'c_dead', agentPageId: null },
        // The straightforward case — this is what keeps thread mode working.
        { id: 'c_client', agentPageId: 'p_two' },
        // Two agents: anchored to the FIRST, matching the runtime's
        // write-once claim.
        { id: 'c_mixed', agentPageId: 'p_one' },
      ].sort((a, b) => a.id.localeCompare(b.id)));

      // Page and global threads keep deriving their page the way they always
      // did — this column is for `type='client'` alone.
      const others = await s.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "conversations" WHERE "type" <> 'client' AND "agentPageId" IS NOT NULL`,
      );
      expect(others[0].n).toBe(0);

      expect(s.notices.join('\n')).toMatch(/named more than one agent page/);
      expect(s.notices.join('\n')).toMatch(/stay page-less/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('RESCUES a straggler the backfill never carried — the version-skipping operator', async () => {
    const s = await openScenario('straggler');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);
      // Legacy-only, exactly as a deployment that never ran
      // scripts/backfill-unify-messages.ts would have it.
      await s.query(`
        INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt", "isActive")
        VALUES ('m_straggler', 'p_one', 'c_page', 'user', 'never backfilled', now(), true);
      `);

      expect(await s.migrate()).toBeNull();

      const rows = await s.query<{ conversationId: string; content: string }>(
        `SELECT "conversationId", "content" FROM "messages" WHERE "id" = 'm_straggler'`,
      );
      expect(rows).toEqual([{ conversationId: 'c_page', content: 'never backfilled' }]);
      expect(s.notices.join('\n')).toMatch(/carried 1 straggler/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('REFUSES to drop when a legacy row cannot be represented, and names the ids', async () => {
    const s = await openScenario('untwinnable');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);
      // A row whose conversation does not exist. The FK 0251 validated makes
      // this unreachable through normal writes, so it has to be dropped to
      // create — which is the point: it is the shape of a corpus that predates
      // the constraint, and it is precisely what must NOT be silently dropped.
      await s.query(`ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_conversationId_conversations_id_fk"`);
      await s.query(`
        INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "createdAt", "isActive") VALUES
          ('m_orphan_a', 'p_one', 'c_missing', 'user', 'unreachable', now(), true),
          ('m_orphan_b', 'p_one', 'c_missing', 'assistant', 'also unreachable', now(), true);
      `);

      const err = await s.migrate();
      expect(err).not.toBeNull();
      const message = errorChain(err);
      expect(message).toContain('2 row(s) that "messages" does not represent');
      expect(message).toContain('m_orphan_a');
      expect(message).toContain('m_orphan_b');

      // THE TABLE SURVIVES. A migration that half-ran a destructive step would
      // be worse than one that refused.
      expect(await tableExists(s, 'chat_messages')).toBe(true);
      expect(await columnExists(s, 'messages', 'pageId')).toBe(true);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('REPAIRS a write that landed on the legacy leg alone — the dual-write window loss', async () => {
    const s = await openScenario('lostwrite');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);

      // THE SHAPE THE ROW-ONLY GUARD CANNOT SEE. Both of these rows HAVE a
      // twin (same id, conversation and role), so the completeness guard is
      // satisfied and the table drops — but the twin is STALE.
      //
      // It gets this way during PR 10's dual-write window, not after the PR 14
      // freeze: an old pod that has not yet picked up the dual-write serves an
      // edit or a soft-delete and writes it to `chat_messages` ONLY. The
      // documented `UNIFIED_MESSAGES_DUAL_WRITE=off` kill switch makes that
      // window operator-controllable and arbitrarily long. Nothing repairs it
      // afterwards: the backfill only ever INSERTs rows that are missing, and
      // the 0253 sweep skips any row that already has a twin.
      //
      // After the freeze the legacy leg is immutable, so each of these shapes
      // is positive proof of a lost write rather than normal divergence.

      // (a) an edit that only the legacy leg received.
      await s.query(`
        UPDATE "chat_messages" SET "content" = 'EDITED TEXT', "editedAt" = now()
         WHERE "id" = 'm_page_1'
      `);
      // (b) a soft-delete that only the legacy leg received. Dropping the
      //     table without repairing this RESURRECTS a deleted message as live.
      await s.query(`
        UPDATE "chat_messages" SET "isActive" = false WHERE "id" = 'm_page_2'
      `);

      expect(await s.migrate()).toBeNull();
      expect(await tableExists(s, 'chat_messages')).toBe(false);

      const rows = await s.query<{
        id: string; content: string; editedAt: Date | null; isActive: boolean;
      }>(
        `SELECT "id", "content", "editedAt", "isActive" FROM "messages"
          WHERE "id" IN ('m_page_1', 'm_page_2') ORDER BY "id"`,
      );

      // The edit survived the drop instead of reverting to the original text.
      expect(rows[0].content).toBe('EDITED TEXT');
      expect(rows[0].editedAt).not.toBeNull();
      // The deletion survived the drop instead of the message coming back.
      expect(rows[1].isActive).toBe(false);

      expect(s.notices.join('\n')).toMatch(/repaired 2 stale unified row\(s\)/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('is idempotent and SILENT when the unified leg is already the newer truth', async () => {
    const s = await openScenario('norepair');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);
      // The healthy post-freeze direction: `messages` carries the edit and the
      // soft-delete, `chat_messages` is the frozen original. The repair must
      // not fire here — running it backwards would undo real edits, which is
      // the exact failure the row-only guard was trying to avoid.
      await s.query(`UPDATE "messages" SET "content" = 'newer', "editedAt" = now() WHERE "id" = 'm_page_1'`);
      await s.query(`UPDATE "messages" SET "isActive" = false WHERE "id" = 'm_page_2'`);

      expect(await s.migrate()).toBeNull();

      const rows = await s.query<{ id: string; content: string; isActive: boolean }>(
        `SELECT "id", "content", "isActive" FROM "messages"
          WHERE "id" IN ('m_page_1', 'm_page_2') ORDER BY "id"`,
      );
      expect(rows[0].content).toBe('newer');
      expect(rows[1].isActive).toBe(false);
      expect(s.notices.join('\n')).toMatch(/no stale unified rows/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('does not mistake a legitimately EDITED message for a lost one', async () => {
    const s = await openScenario('divergent');
    try {
      await seedFixtures(s);
      await seedTwinnedCorpus(s);
      // Since PR 14 froze the legacy leg, every edit / soft-delete / undo
      // tombstone lands on `messages` alone. Divergent content is the NORMAL
      // state of a healthy database, and the guard must not read it as data
      // loss — a content-equality guard would refuse to deploy on every
      // database that has ever served an edit.
      await s.query(`UPDATE "messages" SET "content" = 'edited', "editedAt" = now() WHERE "id" = 'm_page_1'`);
      await s.query(`UPDATE "messages" SET "isActive" = false WHERE "id" = 'm_page_2'`);

      expect(await s.migrate()).toBeNull();
      expect(await tableExists(s, 'chat_messages')).toBe(false);

      const rows = await s.query<{ content: string }>(
        `SELECT "content" FROM "messages" WHERE "id" = 'm_page_1'`,
      );
      expect(rows[0].content).toBe('edited');
    } finally {
      await s.pool.end();
    }
  }, 180_000);
});
