/**
 * Static invariants of the `workspaceState` DROP migration (0251, epic
 * Phase 3 — the CONTRACT step of the relational pane-grid promotion started
 * in 0246).
 *
 * These tests pin the migration SQL itself so CI catches a regenerated or
 * hand-edited migration losing the sweep, the guard, or the ORDER of the
 * three — without a database. A drop that runs before its guard is a data
 * loss with extra steps.
 *
 * The header here used to list six scenarios a human had once replayed by
 * hand against a scratch Postgres. They are now a LIVE suite at the bottom of
 * this file, run by CI on every change, because the hand-run had missed the
 * defect that mattered: 0246 ate a duplicate pane id and this migration then
 * refused to deploy over it, in a loop its own HINT could not break.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations, type RunnableMigration } from '../migration-runner';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => /^0251_.*\.sql$/.test(f));
const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle/0251 workspaceState drop', () => {
  it('should exist in the journal as migration 0251', () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 251)?.tag).toBe(
      path.basename(migrationFile ?? '', '.sql'),
    );
  });

  it('should drop the column, and drop NOTHING else', () => {
    expect(code).toContain('ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "workspaceState"');
    expect(code).not.toContain('DROP TABLE "agent');
    expect(code.match(/DROP COLUMN/g) ?? []).toHaveLength(1);
  });

  it('should order the three phases sweep → guard → drop', () => {
    const sweep = code.indexOf('final sweep');
    const guard = code.indexOf('Refusing to drop');
    const drop = code.indexOf('DROP COLUMN');
    expect(sweep).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(sweep);
    // THE ordering that makes this migration safe: nothing is destroyed until
    // the guard has had its say.
    expect(drop).toBeGreaterThan(guard);
  });

  it('should carry a final blob→rows sweep scoped to sessions that have NO rows', () => {
    expect(code).toContain(`LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY`);
    expect(code).toContain(`LATERAL jsonb_array_elements(col.value -> 'panes') WITH ORDINALITY`);
    // Scoped, not blanket: re-promoting a session that already has rows would
    // resurrect panes the user closed (rows are authoritative).
    expect(code).toContain('SELECT 1 FROM "agent_workspace_pane_columns" c WHERE c."workspaceId" = s."id"');
    expect(code).toContain('SELECT 1 FROM "agent_workspace_panes" p WHERE p."workspaceId" = s."id"');
    expect((code.match(/ON CONFLICT DO NOTHING/g) ?? []).length).toBe(2);
  });

  it('should keep the sweep exactly as tolerant as persistedWorkspaceStateSchema (0246 parity)', () => {
    expect(code).toContain(`jsonb_typeof(s."workspaceState" -> 'columns') = 'array'`);
    expect(code).toContain(`jsonb_typeof(col.value -> 'panes') = 'array'`);
    expect(code).toContain(`pane.value -> 'scope' ->> 'kind'`);
    expect(code).toContain(`pane.value -> 'scope' ->> 'targetId'`);
    // The retired `tabs` field is never read — same as the 0246 promotion.
    expect(code).not.toContain(`'tabs'`);
  });

  it('should RAISE EXCEPTION with counts, up to 50 ids, and a remedy when the blob is ahead of the rows', () => {
    expect(code).toContain('RAISE EXCEPTION');
    expect(code).toContain('Refusing to drop');
    expect(code).toContain('losing_panes, losing_sessions, sample');
    expect(code).toContain('LIMIT 50');
    expect(code).toContain('USING HINT =');
  });

  it('should compare bindings NULL-safely — an unbound pane is not a mismatch', () => {
    expect(code).toContain('p."kind" IS NOT DISTINCT FROM b."kind"');
    expect(code).toContain('p."targetId" IS NOT DISTINCT FROM b."targetId"');
    expect(code).not.toMatch(/p\."targetId" = b\."targetId"/);
  });

  it('should be DIRECTIONAL — rows ahead of the blob is the steady state and must pass', () => {
    // The guard asks only "does a blob pane exist that the rows lack". The
    // reverse (a row the blob does not know) is what a closed pane or a
    // never-blob-written verb looks like, and must never halt the migration.
    expect(code).toContain('FROM "agent_workspace_panes" p');
    expect(code).not.toMatch(/NOT EXISTS \(\s*SELECT 1[^)]*jsonb_array_elements/);
  });

  it('should be re-runnable: every phase short-circuits once the column is gone', () => {
    const guards = code.match(
      /IF NOT EXISTS \(\s*SELECT 1 FROM information_schema\.columns\s*WHERE table_schema = 'public' AND table_name = 'agent_sessions' AND column_name = 'workspaceState'\s*\) THEN/g,
    );
    // One for the sweep block, one for the guard block; the DROP uses IF EXISTS.
    expect(guards).toHaveLength(2);
    expect(code).toContain('DROP COLUMN IF EXISTS');
  });

  it('should announce both phases for operator observability', () => {
    expect((code.match(/RAISE NOTICE/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the schema no longer declares the blob', () => {
  it('should have no workspaceState column on agent_workspaces', async () => {
    const { agentWorkspaces } = await import('../schema/agent-workspaces');
    // Replaces the drift guard that used to assert blob ≡ rows: with the
    // column gone the only thing left to assert is that it IS gone — the
    // relational rows are the single source, so there is nothing to drift
    // against any more.
    expect(Object.keys(agentWorkspaces)).not.toContain('workspaceState');
  });
});

// ───────────────────────────── live behavior ──────────────────────────────
/**
 * The static assertions above never open a database, so for a long time the
 * ONLY evidence that 0246's promotion and 0251's guard behaved was a prose
 * note in this file's header saying a human had once run them by hand. That
 * note was wrong: the promotion silently DROPPED a pane whose id appeared in
 * two columns (`ON CONFLICT DO NOTHING` on the compound PK), and 0251's guard
 * then refused to deploy over the very pane 0246 had eaten — with a HINT whose
 * documented remedy re-ran the same losing promotion and failed identically.
 * Unrecoverable through any documented path, and invisible to a suite that
 * only grepped the SQL.
 *
 * These scenarios drive the real chain (0245 → 0246 → … → 0251) against a real
 * Postgres, which is the only thing that could have caught it.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

const allMigrations: RunnableMigration[] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** Everything BEFORE the pane-grid promotion (… 0245). */
const preGrid = allMigrations.slice(0, 246);
/** Index one past 0251 — the contract step this file is named for. */
const THROUGH_CONTRACT = 252;

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
const TEMPLATE_DB = `psx_wsdrop_tmpl_${suffix}`;
const createdDatabases: string[] = [];
let adminPool: Pool;

interface Scenario {
  dbName: string;
  notices: string[];
  /** Applies migrations up to (not including) index `upTo`. */
  migrate: (upTo?: number) => Promise<Error | null>;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<T[]>;
  /** Drops and re-opens the connection — needed to pick up ALTER DATABASE SET. */
  reconnect: () => Promise<void>;
  close: () => Promise<void>;
}

async function openScenario(name: string): Promise<Scenario> {
  const dbName = `psx_wsdrop_${name}_${suffix}`;
  await adminPool.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
  createdDatabases.push(dbName);

  const notices: string[] = [];
  const connect = () => {
    const p = new Pool({ connectionString: urlForDatabase(dbName), max: 1 });
    p.on('connect', (client) => {
      client.on('notice', (n) => notices.push(`${n.severity}: ${n.message ?? ''}`));
    });
    return p;
  };
  // Mutable so `reconnect()` genuinely swaps the connection every method uses
  // — a closure over the ORIGINAL pool would keep querying an ended one.
  let pool = connect();

  return {
    dbName,
    notices,
    migrate: async (upTo = THROUGH_CONTRACT) => {
      try {
        await runMigrations(drizzle(pool), allMigrations.slice(0, upTo), {
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
    reconnect: async () => {
      await pool.end();
      pool = connect();
    },
    close: async () => {
      await pool.end();
    },
  };
}

/** An owner and a drive for the sessions each scenario seeds. */
async function seedFixtures(s: Scenario): Promise<void> {
  await s.query(`
    INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES
      ('u_owner', 'Owner', 'owner@example.com', now(), now());
    INSERT INTO "drives" ("id", "name", "slug", "ownerId", "createdAt", "updatedAt") VALUES
      ('d_main', 'Main', 'main', 'u_owner', now(), now());
  `);
}

/** A session carrying a client-authored `workspaceState` blob, pre-0246. */
async function seedSession(s: Scenario, id: string, blob: unknown): Promise<void> {
  await s.query(
    `INSERT INTO "agent_sessions" ("id", "driveId", "ownerId", "name", "workspaceState", "createdAt", "updatedAt")
     VALUES ($1, 'd_main', 'u_owner', $1, $2::jsonb, now(), now())`,
    [id, JSON.stringify(blob)],
  );
}

function pane(id: string, kind: string | null, targetId: string | null) {
  return kind === null && targetId === null
    ? { id }
    : { id, scope: { kind, targetId } };
}

async function panesOf(s: Scenario, workspaceId: string) {
  return s.query<{ id: string; columnId: string; kind: string | null; targetId: string | null }>(
    `SELECT "id", "columnId", "kind", "targetId" FROM "agent_workspace_panes"
      WHERE "workspaceId" = $1 ORDER BY "columnId", "orderIndex"`,
    [workspaceId],
  );
}

async function columnExists(s: Scenario, table: string, column: string): Promise<boolean> {
  const rows = await s.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0].n > 0;
}

describeLive('0246 → 0251 pane grid against a real Postgres', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    createdDatabases.push(TEMPLATE_DB);

    // Template at 0245 — BEFORE the pane grid exists, so each scenario can
    // seed a blob and watch the promotion itself run.
    const templatePool = new Pool({ connectionString: urlForDatabase(TEMPLATE_DB), max: 1 });
    try {
      await runMigrations(drizzle(templatePool), preGrid, {
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

  it('pins the base: the template predates the pane grid', async () => {
    const s = await openScenario('preflight');
    try {
      expect(await columnExists(s, 'agent_sessions', 'workspaceState')).toBe(true);
      const rows = await s.query(`SELECT to_regclass('public.agent_workspace_panes') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await s.close();
    }
  }, 120_000);

  it('promotes a healthy blob and drops the column — the steady state', async () => {
    const s = await openScenario('healthy');
    try {
      await seedFixtures(s);
      await seedSession(s, 'ses_ok', {
        columns: [
          { id: 'col-a', panes: [pane('pane-1', 'page', 't1'), pane('pane-2', null, null)] },
          { id: 'col-b', panes: [pane('pane-3', 'chat', 't3')] },
        ],
      });

      expect(await s.migrate()).toBeNull();
      expect(await columnExists(s, 'agent_sessions', 'workspaceState')).toBe(false);

      expect(await panesOf(s, 'ses_ok')).toEqual([
        { id: 'pane-1', columnId: 'col-a', kind: 'page', targetId: 't1' },
        { id: 'pane-2', columnId: 'col-a', kind: null, targetId: null },
        { id: 'pane-3', columnId: 'col-b', kind: 'chat', targetId: 't3' },
      ]);
    } finally {
      await s.close();
    }
  }, 180_000);

  it('KEEPS a pane whose id repeats across two columns, instead of eating it and then blocking on it', async () => {
    const s = await openScenario('duppane');
    try {
      await seedFixtures(s);
      // A client-authored blob is not constrained to unique pane ids, but the
      // relational PK is `(workspaceId, id)`. 0246's `ON CONFLICT DO NOTHING`
      // therefore silently DISCARDED the second occurrence — and 0251's guard
      // then saw a blob pane binding the rows lacked and refused to deploy.
      //
      // Following 0251's own documented HINT ("DELETE its
      // agent_workspace_pane_columns rows so the sweep promotes the blob
      // wholesale") re-ran the identical losing INSERT and failed identically:
      // an unrecoverable loop with no documented way out.
      await seedSession(s, 'ses_dup', {
        columns: [
          { id: 'col-a', panes: [pane('pane-dup', 'page', 'target-first')] },
          { id: 'col-b', panes: [pane('pane-dup', 'page', 'target-second')] },
        ],
      });

      // THE ASSERTION: the chain completes rather than dead-ending.
      expect(await s.migrate()).toBeNull();
      expect(await columnExists(s, 'agent_sessions', 'workspaceState')).toBe(false);

      // Exactly one row survives — the PK cannot hold two — and it is the
      // FIRST occurrence, matching the client's own first-wins read order.
      expect(await panesOf(s, 'ses_dup')).toEqual([
        { id: 'pane-dup', columnId: 'col-a', kind: 'page', targetId: 'target-first' },
      ]);

      // And the collapse is REPORTED rather than silent — an operator must be
      // able to see that a duplicate id was collapsed.
      expect(s.notices.join('\n')).toMatch(/duplicate pane id/i);
    } finally {
      await s.close();
    }
  }, 180_000);

  it('still REFUSES when an old pod genuinely wrote a new pane to the blob after the promotion', async () => {
    const s = await openScenario('blobahead');
    try {
      await seedFixtures(s);
      await seedSession(s, 'ses_ahead', {
        columns: [{ id: 'col-a', panes: [pane('pane-1', 'page', 't1')] }],
      });
      // Promote, then let a stale pod rewrite the blob with a pane the rows
      // have never seen. This is REAL data loss, and must still halt the drop.
      expect(await s.migrate(251)).toBeNull();
      await s.query(`
        UPDATE "agent_sessions" SET "workspaceState" = $1::jsonb WHERE "id" = 'ses_ahead'
      `, [JSON.stringify({
        columns: [{ id: 'col-a', panes: [pane('pane-1', 'page', 't1'), pane('pane-new', 'page', 't9')] }],
      })]);

      const reported = errorChain(await s.migrate());
      expect(reported).toMatch(/Refusing to drop/);
      expect(reported).toContain('ses_ahead');
      // The column SURVIVES — a half-run destructive step is worse than a
      // refusal.
      expect(await columnExists(s, 'agent_sessions', 'workspaceState')).toBe(true);
    } finally {
      await s.close();
    }
  }, 180_000);

  it('offers an operator escape hatch for blob-ahead-of-rows that does not need the blocked client', async () => {
    const s = await openScenario('escapehatch');
    try {
      await seedFixtures(s);
      await seedSession(s, 'ses_ahead', {
        columns: [{ id: 'col-a', panes: [pane('pane-1', 'page', 't1')] }],
      });
      expect(await s.migrate(251)).toBeNull();
      await s.query(`
        UPDATE "agent_sessions" SET "workspaceState" = $1::jsonb WHERE "id" = 'ses_ahead'
      `, [JSON.stringify({
        columns: [{ id: 'col-a', panes: [pane('pane-1', 'page', 't1'), pane('pane-new', 'page', 't9')] }],
      })]);

      // The guard's original HINT told the operator to "open it in a current
      // client" — but the current client is exactly what this migration is
      // blocking the deploy of, so that remedy is circular for a tenant/onprem
      // operator mid-upgrade. A settable parameter breaks the loop WITHOUT
      // needing the app, and is deliberately explicit rather than a default.
      await adminPool.query(
        `ALTER DATABASE "${s.dbName}" SET "pagespace.workspace_state_force_drop" = 'on'`,
      );
      // Reconnect so the new database-level setting is picked up.
      await s.reconnect();

      expect(await s.migrate()).toBeNull();
      expect(await columnExists(s, 'agent_sessions', 'workspaceState')).toBe(false);
      // Forcing is LOUD: the panes it knowingly discarded are named.
      expect(s.notices.join('\n')).toMatch(/FORCED by pagespace\.workspace_state_force_drop/);
      expect(s.notices.join('\n')).toContain('ses_ahead');
    } finally {
      await s.close();
    }
  }, 180_000);

  it('rescues a session whose blob was never promoted, and re-runs as a no-op', async () => {
    const s = await openScenario('sweep');
    try {
      await seedFixtures(s);
      expect(await s.migrate(247)).toBeNull();
      // Born on an old instance AFTER 0246 ran: blob written, rows never.
      await seedSession(s, 'ses_late', {
        columns: [{ id: 'col-a', panes: [pane('pane-late', 'page', 't1')] }],
      });

      expect(await s.migrate()).toBeNull();
      expect(await panesOf(s, 'ses_late')).toEqual([
        { id: 'pane-late', columnId: 'col-a', kind: 'page', targetId: 't1' },
      ]);

      // Re-running the file against an already-contracted database is clean.
      const file = readdirSync(MIGRATIONS_DIR).find((f) => /^0251_.*\.sql$/.test(f)) as string;
      await s.query(
        readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').split('--> statement-breakpoint').join(''),
      );
      expect(s.notices.join('\n')).toMatch(/already dropped/);
    } finally {
      await s.close();
    }
  }, 180_000);
});
