/**
 * Migrations 0248 (messages-unification EXPAND) and 0249 (integrity
 * constraints) — epic "Agent-Session Single Source of Truth", Phase 4
 * (docs/2.0-architecture/agent-sessions.md; plan D6).
 *
 * Two layers, deliberately:
 *
 *   1. STATIC invariants of the migration SQL, which run everywhere with no
 *     database (the repo's `*-migration.test.ts` precedent — 0246/0247). They
 *     catch a regenerated or hand-edited migration silently losing the orphan
 *     synthesis, the NOT VALID qualifiers, or the expand-only guarantee.
 *
 *   2. LIVE behavior against a real Postgres, run whenever DATABASE_URL is set
 *      (which it is for `bun run test`, `./scripts/test-with-db.sh` and CI).
 *      A fresh database is migrated to 0247, kept as a TEMPLATE, and each
 *      scenario gets its own copy of it — so every scenario seeds a legacy
 *      corpus and then watches 0248/0249 actually run against it. The app's
 *      own database is never touched: everything happens in throwaway
 *      databases created and dropped by this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
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

const expand = readMigration(248);
const integrity = readMigration(249);

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };

describe('drizzle/0248 messages unification — expand', () => {
  it('should be migration 0248 in the journal', () => {
    expect(journal.entries.find((e) => e.idx === 248)?.tag).toBe(
      path.basename(expand.file, '.sql'),
    );
  });

  it('should widen messages: userId nullable, pageId + sourceAgentId added', () => {
    expect(expand.code).toContain('ALTER TABLE "messages" ALTER COLUMN "userId" DROP NOT NULL;');
    expect(expand.code).toContain('ALTER TABLE "messages" ADD COLUMN "pageId" text;');
    expect(expand.code).toContain('ALTER TABLE "messages" ADD COLUMN "sourceAgentId" text;');
    // sourceAgentId keeps chat_messages' semantics: deleting an agent must
    // never delete the transcript it produced.
    expect(expand.code).toContain(
      'ADD CONSTRAINT "messages_sourceAgentId_pages_id_fk" FOREIGN KEY ("sourceAgentId") REFERENCES "public"."pages"("id") ON DELETE set null',
    );
    // The transitional pageId gets no FK — it is dropped at the contract PR.
    expect(expand.code).not.toMatch(/FOREIGN KEY \("pageId"\)/);
  });

  it('should NOT constrain attribution — legacy NULL/NULL rows must copy verbatim', () => {
    expect(expand.code).not.toMatch(/ADD CONSTRAINT[^;]*CHECK/i);
  });

  it('should audit conversationId → pageId as 1:1 BEFORE writing anything, and raise on violation', () => {
    const auditAt = expand.code.indexOf('count(DISTINCT cm."pageId") > 1');
    const insertAt = expand.code.indexOf('INSERT INTO "conversations"');
    expect(auditAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(auditAt);
    expect(expand.code).toContain('RAISE EXCEPTION');
    // The offending ids are listed, not merely counted — a migration that
    // fails without naming the rows to repair is a dead end.
    expect(expand.code).toContain('string_agg');
  });

  it('should scope the fatal straddle audit to NON-client conversations', () => {
    // A `type='client'` (API) thread is anchored to a drive and may legitimately
    // address several agent pages, so it can never satisfy the 1:1 premise and
    // must not abort the upgrade. Both the count and the sample must carry the
    // exclusion — a sample that still names excused threads would send the
    // operator hunting for a straddle that is allowed.
    const exclusions = expand.code.match(/c[v]?\."type" = 'client'\s*\)/g) ?? [];
    expect(exclusions.length).toBe(2);
    expect(expand.code).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM "conversations" c\s+WHERE c\."id" = cm\."conversationId" AND c\."type" = 'client'/,
    );
  });

  it('should synthesize orphan conversations by the locked ownership ladder', () => {
    // 1. earliest USER-ROLE message's userId (not merely the earliest userId).
    expect(expand.code).toMatch(/DISTINCT ON \(cm\."conversationId"\)/);
    expect(expand.code).toContain(`WHERE cm."role" = 'user'`);
    expect(expand.code).toContain('ORDER BY cm."conversationId", cm."createdAt" ASC, cm."id" ASC');
    // 2. page creator → 3. drive owner.
    expect(expand.code).toContain('COALESCE(fh.user_id, p."createdBy", d."ownerId")');
    // Minted shape: page conversation, context = the messages' page, no title.
    expect(expand.code).toContain(`'page'`);
    expect(expand.code).toContain('min(cm."createdAt")');
    expect(expand.code).toContain('max(cm."createdAt")');
  });

  it('should quarantine fully tombstoned conversations and skip unresolvable ones loudly', () => {
    expect(expand.code).toContain('bool_or(cm."isActive")');
    expect(expand.code).toContain('CASE WHEN o.has_active_message THEN o.last_at ELSE now() END');
    expect(expand.code).toMatch(/WHERE o\.owner_id IS NULL/);
    expect(expand.code).toContain('RAISE NOTICE');
    expect(expand.code).toContain('RAISE WARNING');
  });

  it('should be idempotent — ON CONFLICT DO NOTHING and guarded DDL', () => {
    expect(expand.code).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(expand.code).toContain('FROM pg_constraint');
    expect(expand.code).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('should add the chat_messages FK as NOT VALID, cascading', () => {
    expect(expand.code).toContain(
      'ADD CONSTRAINT "chat_messages_conversationId_conversations_id_fk"',
    );
    expect(expand.code).toMatch(
      /FOREIGN KEY \("conversationId"\) REFERENCES "public"\."conversations"\("id"\)\s*\n?\s*ON DELETE cascade ON UPDATE no action\s*\n?\s*NOT VALID/,
    );
    // Validation is a LATER PR — this migration must never scan the corpus.
    // (The phrase appears in a RAISE WARNING; what must not exist is the DDL.)
    expect(expand.code).not.toMatch(/ALTER TABLE[^;]*VALIDATE CONSTRAINT/);
  });

  it('should gate the parity indexes on the corpus size, with both paths present', () => {
    expect(expand.code).toContain(`FROM pg_class`);
    expect(expand.code).toContain('reltuples::bigint');
    expect(expand.code).toContain('CREATE INDEX IF NOT EXISTS "messages_page_id_idx"');
    expect(expand.code).toContain(
      'CREATE INDEX IF NOT EXISTS "messages_page_id_is_active_created_at_idx"',
    );
    // The above-the-gate path names a deferred operator script. That script
    // is GONE as of 0252, and deliberately: both indexes it built are on
    // `messages."pageId"`, the transitional column 0252 drops, so anything
    // still holding it would either be redundant (0248 and 0252 apply in the
    // same batch) or actively broken (`CREATE INDEX CONCURRENTLY` on a column
    // that no longer exists). The migration text keeps naming it because
    // applied migrations are never edited.
    expect(expand.code).toContain('0248-messages-unification-indexes.sql');
    expect(
      existsSync(path.resolve(__dirname, '../../../../scripts/deferred-migrations/0248-messages-unification-indexes.sql')),
    ).toBe(false);
  });

  it('should be expand-only — nothing dropped, renamed, or deleted', () => {
    expect(expand.code).not.toContain('DROP TABLE');
    expect(expand.code).not.toContain('DROP COLUMN');
    expect(expand.code).not.toMatch(/\bRENAME\b/);
    expect(expand.code).not.toMatch(/^\s*(DELETE FROM|TRUNCATE)\b/m);
    // The only UPDATE-shaped statement allowed is none: synthesis inserts.
    expect(expand.code).not.toMatch(/^\s*UPDATE\s+"/m);
  });
});

describe('drizzle/0249 integrity constraints', () => {
  it('should be migration 0249 in the journal', () => {
    expect(journal.entries.find((e) => e.idx === 249)?.tag).toBe(
      path.basename(integrity.file, '.sql'),
    );
  });

  it('should add all three type ⇄ contextId checks NOT VALID', () => {
    for (const [name, predicate] of [
      ['conversations_global_context_null_chk', `"conversations"."type" <> 'global' OR "conversations"."contextId" IS NULL`],
      ['conversations_page_context_present_chk', `"conversations"."type" <> 'page' OR "conversations"."contextId" IS NOT NULL`],
      ['conversations_drive_context_present_chk', `"conversations"."type" <> 'drive' OR "conversations"."contextId" IS NOT NULL`],
    ] as const) {
      expect(integrity.code).toContain(`ADD CONSTRAINT "${name}"`);
      expect(integrity.code).toContain(`CHECK (${predicate})`);
    }
    // One NOT VALID clause per constraint added (3 checks + 1 FK).
    expect((integrity.code.match(/^\s*NOT VALID;$/gm) ?? []).length).toBe(4);
  });

  it('should give ai_stream_sessions.conversation_id a real cascading FK, NOT VALID', () => {
    expect(integrity.code).toContain(
      'ADD CONSTRAINT "ai_stream_sessions_conversation_id_conversations_id_fk"',
    );
    expect(integrity.code).toMatch(
      /FOREIGN KEY \("conversation_id"\) REFERENCES "public"\."conversations"\("id"\)\s*\n?\s*ON DELETE cascade/,
    );
    expect(integrity.code).not.toMatch(/ALTER TABLE[^;]*VALIDATE CONSTRAINT/);
  });

  it('should never repair rows — it audits and reports instead', () => {
    expect(integrity.code).not.toMatch(/^\s*(UPDATE|DELETE FROM|TRUNCATE)\b/m);
    expect(integrity.code).toContain('RAISE NOTICE');
  });
});

// ───────────────────────────── live behavior ──────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

/** All migrations, in journal order. Index N === journal idx N. */
const allMigrations: RunnableMigration[] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** Everything BEFORE this PR's two migrations — the "yesterday" schema. */
const baseMigrations = allMigrations.slice(0, 248);
/**
 * Base + 0248 + 0249, and nothing after. Bounded on purpose: later migrations
 * are entitled to reject corpora these scenarios deliberately construct (0250
 * aborts on the unresolvable-orphan scenario below, which is exactly its job),
 * and this suite is about what 0248/0249 do to a database, not about the head
 * of the journal.
 */
const throughThisPr = allMigrations.slice(0, 250);

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
const TEMPLATE_DB = `psx_expand_tmpl_${suffix}`;
const createdDatabases: string[] = [];

let adminPool: Pool;

/** A scratch database seeded to 0247, plus the notices its migrations emitted. */
interface Scenario {
  pool: Pool;
  notices: string[];
  /** Applies 0248 + 0249. Resolves to the error when the migration aborts. */
  migrate: () => Promise<Error | null>;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<T[]>;
}

async function openScenario(name: string): Promise<Scenario> {
  const dbName = `psx_expand_${name}_${suffix}`;
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

/** Users, a drive and pages every scenario builds its legacy corpus on. */
async function seedFixtures(s: Scenario): Promise<void> {
  await s.query(`
    INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES
      ('u_speaker', 'Speaker', 'speaker@example.com', now(), now()),
      ('u_second',  'Second',  'second@example.com',  now(), now()),
      ('u_creator', 'Creator', 'creator@example.com', now(), now()),
      ('u_owner',   'Owner',   'owner@example.com',   now(), now());

    INSERT INTO "drives" ("id", "name", "slug", "ownerId", "createdAt", "updatedAt") VALUES
      ('d_main', 'Main', 'main', 'u_owner', now(), now());

    INSERT INTO "pages" ("id", "title", "type", "position", "driveId", "createdBy", "createdAt", "updatedAt") VALUES
      ('p_with_creator', 'With creator', 'AI_CHAT', 1, 'd_main', 'u_creator', now(), now()),
      ('p_no_creator',   'No creator',   'AI_CHAT', 2, 'd_main', NULL,        now(), now());
  `);
}

async function insertChatMessage(
  s: Scenario,
  row: {
    id: string;
    pageId: string;
    conversationId: string;
    role: string;
    content?: string;
    userId?: string | null;
    createdAt: string;
    isActive?: boolean;
  },
): Promise<void> {
  await s.query(
    `INSERT INTO "chat_messages" ("id", "pageId", "conversationId", "role", "content", "userId", "createdAt", "isActive")
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, $8)`,
    [
      row.id,
      row.pageId,
      row.conversationId,
      row.role,
      row.content ?? 'hello',
      row.userId ?? null,
      row.createdAt,
      row.isActive ?? true,
    ],
  );
}

describeLive('0248/0249 against a real Postgres', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    createdDatabases.push(TEMPLATE_DB);

    // Migrate the template to 0247 — the schema as it stands BEFORE this PR —
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

  it('pins the base: the scenarios below apply exactly 0248 and 0249', () => {
    expect(allMigrations.length).toBe(journal.entries.length);
    expect(throughThisPr.length - baseMigrations.length).toBe(2);
    expect(journal.entries[248]?.idx).toBe(248);
    expect(journal.entries[249]?.idx).toBe(249);
  });

  it('resolves ownership by the ladder, quarantines tombstoned threads, and is idempotent', async () => {
    const s = await openScenario('ladder');
    try {
      await seedFixtures(s);

      // c_human: an assistant row carrying u_second's id comes FIRST in time,
      // then u_speaker's user message, then u_second's. Ownership must follow
      // the earliest USER-ROLE message (u_speaker), not the earliest userId.
      await insertChatMessage(s, { id: 'm1', pageId: 'p_with_creator', conversationId: 'c_human', role: 'assistant', userId: 'u_second', createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'm2', pageId: 'p_with_creator', conversationId: 'c_human', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 11:00:00' });
      await insertChatMessage(s, { id: 'm3', pageId: 'p_with_creator', conversationId: 'c_human', role: 'user', userId: 'u_second', createdAt: '2024-01-01 12:00:00' });

      // c_creator: nobody human ever spoke → the page's creator owns it.
      await insertChatMessage(s, { id: 'm4', pageId: 'p_with_creator', conversationId: 'c_creator', role: 'assistant', userId: null, createdAt: '2024-02-01 10:00:00' });
      await insertChatMessage(s, { id: 'm5', pageId: 'p_with_creator', conversationId: 'c_creator', role: 'user', userId: null, createdAt: '2024-02-01 11:00:00' });

      // c_drive: no human, no page creator → the drive owner.
      await insertChatMessage(s, { id: 'm6', pageId: 'p_no_creator', conversationId: 'c_drive', role: 'assistant', userId: null, createdAt: '2024-03-01 10:00:00' });

      // c_dead: every message already tombstoned → quarantined, not resurrected.
      await insertChatMessage(s, { id: 'm7', pageId: 'p_no_creator', conversationId: 'c_dead', role: 'user', userId: 'u_speaker', createdAt: '2024-04-01 10:00:00', isActive: false });
      await insertChatMessage(s, { id: 'm8', pageId: 'p_no_creator', conversationId: 'c_dead', role: 'assistant', userId: null, createdAt: '2024-04-01 10:01:00', isActive: false });

      // c_existing: already has a row owned by u_second — synthesis must not
      // touch it, even though u_speaker spoke first in it.
      await s.query(
        `INSERT INTO "conversations" ("id", "userId", "title", "type", "contextId", "createdAt", "updatedAt")
         VALUES ('c_existing', 'u_second', 'Kept', 'page', 'p_with_creator', now(), now())`,
      );
      await insertChatMessage(s, { id: 'm9', pageId: 'p_with_creator', conversationId: 'c_existing', role: 'user', userId: 'u_speaker', createdAt: '2024-05-01 10:00:00' });

      expect(await s.migrate()).toBeNull();

      const rows = await s.query<{ id: string; userId: string; type: string; contextId: string; isActive: boolean; title: string | null; isShared: boolean; lastMessageAt: Date; createdAt: Date }>(
        `SELECT "id", "userId", "type", "contextId", "isActive", "title", "isShared", "lastMessageAt", "createdAt"
         FROM "conversations" ORDER BY "id"`,
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

      expect(rows).toHaveLength(5);
      expect(byId.c_human).toMatchObject({ userId: 'u_speaker', type: 'page', contextId: 'p_with_creator', isActive: true, title: null, isShared: false });
      expect(byId.c_creator).toMatchObject({ userId: 'u_creator', contextId: 'p_with_creator', isActive: true });
      expect(byId.c_drive).toMatchObject({ userId: 'u_owner', contextId: 'p_no_creator', isActive: true });
      // Quarantined: owned by the human who spoke, but unclaimable.
      expect(byId.c_dead).toMatchObject({ userId: 'u_speaker', isActive: false });
      // Untouched.
      expect(byId.c_existing).toMatchObject({ userId: 'u_second', title: 'Kept' });

      // Timestamps come from the messages, not from now(). Compared in SQL so
      // the assertion does not depend on the runner's timezone.
      expect(
        await s.query<{ ok: boolean }>(
          `SELECT "createdAt" = '2024-01-01 10:00:00'::timestamp AND "lastMessageAt" = '2024-01-01 12:00:00'::timestamp AS ok
           FROM "conversations" WHERE "id" = 'c_human'`,
        ),
      ).toEqual([{ ok: true }]);
      // The quarantined row's updatedAt is stamped now(), so its retention
      // grace period runs from the migration rather than from 2024.
      expect(
        await s.query<{ ok: boolean }>(
          `SELECT "updatedAt" > now() - interval '5 minutes' AS ok FROM "conversations" WHERE "id" = 'c_dead'`,
        ),
      ).toEqual([{ ok: true }]);

      // The contested-ownership notice fired for c_human (two humans).
      expect(s.notices.join('\n')).toMatch(/more than one human author/);

      // A NEW row naming a conversation that does not exist is now rejected...
      await expect(
        insertChatMessage(s, { id: 'm_bogus', pageId: 'p_with_creator', conversationId: 'nope', role: 'user', userId: 'u_speaker', createdAt: '2025-01-01 10:00:00' }),
      ).rejects.toMatchObject({ code: '23503' });

      // ...and deleting a conversation now takes its messages with it.
      await s.query(`DELETE FROM "conversations" WHERE "id" = 'c_drive'`);
      expect(await s.query(`SELECT 1 FROM "chat_messages" WHERE "conversationId" = 'c_drive'`)).toHaveLength(0);

      // Idempotency: replaying every hand-appended block of 0248 (the audit,
      // the synthesis, the FK, the index gate) changes nothing. The generated
      // `ADD COLUMN` statements above them are not replayable and do not need
      // to be — the journal hash is what stops a migration running twice; the
      // DO blocks are what must survive a partial run being retried.
      const before = await s.query<{ count: string }>(`SELECT count(*)::text AS count FROM "conversations"`);
      const client = await s.pool.connect();
      try {
        await client.query('BEGIN');
        const blocks = expand.sql
          .split('--> statement-breakpoint')
          .map((statement) => statement.trim())
          .filter((statement) => statement.includes('DO $$'));
        expect(blocks).toHaveLength(4);
        for (const block of blocks) await client.query(block);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const after = await s.query<{ count: string }>(`SELECT count(*)::text AS count FROM "conversations"`);
      expect(after[0].count).toBe(before[0].count);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('aborts when one conversationId spans two pages, leaving the schema untouched', async () => {
    const s = await openScenario('straddle');
    try {
      await seedFixtures(s);
      await insertChatMessage(s, { id: 'm1', pageId: 'p_with_creator', conversationId: 'c_split', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'm2', pageId: 'p_no_creator', conversationId: 'c_split', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 11:00:00' });

      const err = await s.migrate();
      // drizzle wraps the driver error, so the postgres message is on the
      // cause chain rather than the top-level message.
      const reported = errorChain(err);
      expect(reported).toMatch(/span more than one pageId/);
      expect(reported).toContain('c_split');

      // The whole migration rolled back: no synthesis, no FK, no new columns.
      expect(await s.query(`SELECT 1 FROM "conversations"`)).toHaveLength(0);
      expect(
        await s.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'pageId'`),
      ).toHaveLength(0);
      expect(
        await s.query(`SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_conversationId_conversations_id_fk'`),
      ).toHaveLength(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('lets a type=client thread that spoke to TWO agent pages through, instead of aborting the upgrade', async () => {
    const s = await openScenario('clientstraddle');
    try {
      await seedFixtures(s);
      // A `type='client'` (API) thread is anchored to a DRIVE, not a page, and
      // is DOCUMENTED as being able to address more than one agent page over
      // its life (docs/2.0-architecture/agent-sessions.md). Its rows therefore
      // straddle two pageIds BY DESIGN — that is a supported production shape,
      // not the drift the pre-audit exists to catch.
      //
      // The pre-audit's premise ("a conversationId must name exactly one page,
      // because contextId has to represent it") simply does not apply here:
      // this conversation's `contextId` is the drive, and 0252 later derives
      // its page into `agentPageId`, anchoring to the earliest and merely
      // WARNING (`% client conversation(s) named more than one agent page`).
      // Aborting on it makes the upgrade impossible for any deployment that
      // ever served a two-agent API thread.
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "isActive", "updatedAt") VALUES
          ('c_client_multi', 'u_speaker', 'client', 'd_main', true, now());
      `);
      await insertChatMessage(s, { id: 'mc1', pageId: 'p_with_creator', conversationId: 'c_client_multi', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'mc2', pageId: 'p_no_creator', conversationId: 'c_client_multi', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 11:00:00' });

      // THE ASSERTION: it survives.
      expect(await s.migrate()).toBeNull();

      // The client conversation is untouched — still a client thread, still
      // anchored to its drive. Synthesis never had anything to do here.
      const rows = await s.query<{ id: string; type: string; contextId: string | null }>(
        `SELECT "id", "type", "contextId" FROM "conversations" WHERE "id" = 'c_client_multi'`,
      );
      expect(rows).toEqual([{ id: 'c_client_multi', type: 'client', contextId: 'd_main' }]);

      // And the expand actually happened rather than being rolled back.
      expect(
        await s.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'pageId'`),
      ).toHaveLength(1);

      // It is still REPORTED — a client straddle is expected, but the operator
      // should see it on the deploy record (the second, non-fatal audit).
      expect(s.notices.join('\n')).toMatch(/disagree with their chat_messages about the page/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('still ABORTS on a genuine page-conversation straddle even when a client straddle is present', async () => {
    const s = await openScenario('mixedstraddle');
    try {
      await seedFixtures(s);
      // Both shapes in one corpus. The client straddle must be excused; the
      // page straddle must still stop the migration dead. Excusing the first
      // must not blunt the guard for the second.
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "isActive", "updatedAt") VALUES
          ('c_client_ok', 'u_speaker', 'client', 'd_main', true, now());
      `);
      await insertChatMessage(s, { id: 'mc1', pageId: 'p_with_creator', conversationId: 'c_client_ok', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'mc2', pageId: 'p_no_creator', conversationId: 'c_client_ok', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 11:00:00' });
      // The genuine offender: no conversations row at all, so synthesis would
      // have to GUESS which page it belongs to.
      await insertChatMessage(s, { id: 'mp1', pageId: 'p_with_creator', conversationId: 'c_page_split', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'mp2', pageId: 'p_no_creator', conversationId: 'c_page_split', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 11:00:00' });

      const reported = errorChain(await s.migrate());
      expect(reported).toMatch(/span more than one pageId/);
      expect(reported).toContain('c_page_split');
      // The excused client thread is NOT named as an offender.
      expect(reported).not.toContain('c_client_ok');
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('skips unresolvable orphans loudly, and leaves their pre-existing rows alone', async () => {
    const s = await openScenario('unresolvable');
    try {
      await seedFixtures(s);
      // Force the defensive branch: without the pageId FK a message can name a
      // page that does not exist, so no creator and no drive owner resolve.
      // This is the shape a partially restored corpus has.
      await s.query(`ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_pageId_pages_id_fk"`);
      await insertChatMessage(s, { id: 'm1', pageId: 'p_vanished', conversationId: 'c_orphaned', role: 'user', userId: null, createdAt: '2024-01-01 10:00:00' });
      await insertChatMessage(s, { id: 'm2', pageId: 'p_with_creator', conversationId: 'c_fine', role: 'user', userId: 'u_speaker', createdAt: '2024-01-01 10:00:00' });

      expect(await s.migrate()).toBeNull();

      const rows = await s.query<{ id: string }>(`SELECT "id" FROM "conversations" ORDER BY "id"`);
      expect(rows.map((r) => r.id)).toEqual(['c_fine']);

      const notices = s.notices.join('\n');
      expect(notices).toMatch(/1 SKIPPED/);
      expect(notices).toMatch(/WARNING/);
      expect(notices).toMatch(/VALIDATE CONSTRAINT/);

      // NOT VALID: the pre-existing parentless row survives the FK...
      expect(await s.query(`SELECT 1 FROM "chat_messages" WHERE "conversationId" = 'c_orphaned'`)).toHaveLength(1);
      expect(
        await s.query<{ convalidated: boolean }>(
          `SELECT convalidated FROM pg_constraint WHERE conname = 'chat_messages_conversationId_conversations_id_fk'`,
        ),
      ).toEqual([{ convalidated: false }]);
      // ...while a new write into that same parentless conversation is refused.
      await expect(
        insertChatMessage(s, { id: 'm3', pageId: 'p_with_creator', conversationId: 'c_orphaned', role: 'user', userId: 'u_speaker', createdAt: '2025-01-01 10:00:00' }),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('enforces 0249 on new writes while grandfathering legacy-shaped rows', async () => {
    const s = await openScenario('integrity');
    try {
      await seedFixtures(s);
      // Legacy-shaped rows that the new CHECKs would reject, written BEFORE
      // the constraints exist.
      await s.query(`
        INSERT INTO "conversations" ("id", "userId", "type", "contextId", "createdAt", "updatedAt") VALUES
          ('c_legacy_global', 'u_speaker', 'global', 'p_with_creator', now(), now()),
          ('c_legacy_page',   'u_speaker', 'page',   NULL,             now(), now());
      `);
      // A stream row pointing at a conversation that does not exist — the
      // pre-count this FK has to grandfather.
      await s.query(`
        INSERT INTO "ai_stream_sessions" ("message_id", "channel_id", "conversation_id", "user_id")
        VALUES ('msg_dangling', 'chan', 'c_never_existed', 'u_speaker');
      `);

      expect(await s.migrate()).toBeNull();

      // Grandfathered: still there, and the audit counted them.
      expect(await s.query(`SELECT 1 FROM "conversations" WHERE "id" IN ('c_legacy_global','c_legacy_page')`)).toHaveLength(2);
      expect(await s.query(`SELECT 1 FROM "ai_stream_sessions" WHERE "message_id" = 'msg_dangling'`)).toHaveLength(1);
      expect(s.notices.join('\n')).toMatch(/pre-audit: 1 ai_stream_sessions row/);

      // New writes are checked immediately.
      await expect(
        s.query(`INSERT INTO "conversations" ("id","userId","type","contextId","createdAt","updatedAt") VALUES ('c_new_global','u_speaker','global','p_with_creator',now(),now())`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        s.query(`INSERT INTO "conversations" ("id","userId","type","contextId","createdAt","updatedAt") VALUES ('c_new_page','u_speaker','page',NULL,now(),now())`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        s.query(`INSERT INTO "conversations" ("id","userId","type","contextId","createdAt","updatedAt") VALUES ('c_new_drive','u_speaker','drive',NULL,now(),now())`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        s.query(`INSERT INTO "ai_stream_sessions" ("message_id","channel_id","conversation_id","user_id") VALUES ('msg_new','chan','c_still_missing','u_speaker')`),
      ).rejects.toMatchObject({ code: '23503' });

      // And the stream row cascades with its conversation.
      await s.query(`INSERT INTO "conversations" ("id","userId","type","contextId","createdAt","updatedAt") VALUES ('c_ok','u_speaker','page','p_with_creator',now(),now())`);
      await s.query(`INSERT INTO "ai_stream_sessions" ("message_id","channel_id","conversation_id","user_id") VALUES ('msg_ok','chan','c_ok','u_speaker')`);
      await s.query(`DELETE FROM "conversations" WHERE "id" = 'c_ok'`);
      expect(await s.query(`SELECT 1 FROM "ai_stream_sessions" WHERE "message_id" = 'msg_ok'`)).toHaveLength(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);
});
