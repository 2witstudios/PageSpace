/**
 * Static invariants of the `workspaceState` DROP migration (0251, epic
 * Phase 3 — the CONTRACT step of the relational pane-grid promotion started
 * in 0246).
 *
 * The live behavior was verified against a scratch Postgres 17 (fresh
 * full-migration run, then six seeded corpora replayed against the file):
 *   A. healthy (blob ≡ rows)         → sweep no-op, guard silent, column dropped
 *   B. blob never promoted (no rows) → sweep promoted 1 column / 1 pane, then dropped
 *   C. blob AHEAD of rows            → RAISE EXCEPTION naming 2 panes / 2 sessions
 *                                      (`ses-c, ses-c2`); the column SURVIVED
 *   D. re-run after a successful run → clean no-op, rows intact
 *   E. unbound + null-target panes   → NULL-safe compare, no false positive
 *   F. malformed blobs               → neither promoted nor blocking
 *
 * These tests pin the migration SQL itself so CI catches a regenerated or
 * hand-edited migration losing the sweep, the guard, or the ORDER of the
 * three — without a database. A drop that runs before its guard is a data
 * loss with extra steps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

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
