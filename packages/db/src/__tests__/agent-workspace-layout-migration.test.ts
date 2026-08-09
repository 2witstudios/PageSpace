/**
 * Static invariants of the agent-workspace-layout migration (0247, epic
 * Phase 3 — the #2202 machine-panes pattern re-cut for sessions).
 *
 * These tests pin the migration SQL itself so CI catches a regenerated or
 * hand-edited migration losing the backfill, the cascade topology, or the
 * strictly-additive guarantee — without a database.
 *
 * The LIVE behavior of this promotion is exercised in
 * `workspace-state-drop-migration.test.ts`, which drives the whole 0245 → 0252
 * chain against a real Postgres. That matters: this file's header used to
 * claim the promotion "was verified against a scratch Postgres 17" by hand,
 * and the claim was wrong — the promotion silently ate a pane whose id
 * appeared in two columns, which no string assertion here could have seen.
 * A hand-run that nobody can re-run is not a test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => /^0247_.*\.sql$/.test(f));
const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle/0247 agent workspace layout promotion', () => {
  it('should exist in the journal as migration 0247', () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 247)?.tag).toBe(
      path.basename(migrationFile ?? '', '.sql'),
    );
  });

  it('should create all four layout tables', () => {
    for (const table of [
      'agent_workspace_pane_columns',
      'agent_workspace_panes',
      'agent_workspace_layout_revs',
      'agent_workspace_layout_ops',
    ]) {
      expect(code).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('should key columns and panes by the compound (workspaceId, id) — ids are client-minted', () => {
    expect(code).toContain('CONSTRAINT "agent_workspace_pane_columns_workspaceId_id_pk" PRIMARY KEY("workspaceId","id")');
    expect(code).toContain('CONSTRAINT "agent_workspace_panes_workspaceId_id_pk" PRIMARY KEY("workspaceId","id")');
  });

  it('should cascade the whole grid from agent_workspaces, and panes from their column via the composite FK', () => {
    expect(code).toContain(
      'ALTER TABLE "agent_workspace_pane_columns" ADD CONSTRAINT "agent_workspace_pane_columns_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade',
    );
    expect(code).toContain(
      'FOREIGN KEY ("workspaceId","columnId") REFERENCES "public"."agent_workspace_pane_columns"("workspaceId","id") ON DELETE cascade',
    );
  });

  it('should keep the rev in its OWN cascading table, defaulting to 0 (never a column on agent_workspaces)', () => {
    expect(code).toContain('"rev" bigint DEFAULT 0 NOT NULL');
    expect(code).toContain(
      'ALTER TABLE "agent_workspace_layout_revs" ADD CONSTRAINT "agent_workspace_layout_revs_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade',
    );
    expect(code).not.toContain('ALTER TABLE "agent_sessions" ADD COLUMN "rev"');
  });

  it('should cascade the op-memory table and key it by (workspaceId, opId)', () => {
    expect(code).toContain('CONSTRAINT "agent_workspace_layout_ops_workspaceId_opId_pk" PRIMARY KEY("workspaceId","opId")');
    expect(code).toContain(
      'ALTER TABLE "agent_workspace_layout_ops" ADD CONSTRAINT "agent_workspace_layout_ops_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade',
    );
  });

  it('should put NO foreign key on targetId — polymorphic by design (deleted targets repair at read/bind time)', () => {
    expect(code).not.toMatch(/FOREIGN KEY \("targetId"\)/);
  });

  it('should index the workspace slice of both row tables', () => {
    expect(code).toContain('CREATE INDEX "agent_workspace_pane_columns_workspace_idx" ON "agent_workspace_pane_columns" USING btree ("workspaceId")');
    expect(code).toContain('CREATE INDEX "agent_workspace_panes_workspace_idx" ON "agent_workspace_panes" USING btree ("workspaceId")');
  });

  it('should carry the idempotent blob->rows backfill (DO $$, WITH ORDINALITY, ON CONFLICT DO NOTHING, RAISE NOTICE)', () => {
    expect(code).toContain('DO $$');
    expect(code).toContain(`LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY`);
    expect(code).toContain(`LATERAL jsonb_array_elements(col.value -> 'panes') WITH ORDINALITY`);
    expect((code.match(/ON CONFLICT DO NOTHING/g) ?? []).length).toBe(2);
    expect(code).toContain('RAISE NOTICE');
  });

  it('should be exactly as tolerant as persistedWorkspaceStateSchema: array-guarded, null-safe scopes', () => {
    // A malformed blob (columns not an array) is skipped, never an error...
    expect(code).toContain(`jsonb_typeof(s."workspaceState" -> 'columns') = 'array'`);
    expect(code).toContain(`jsonb_typeof(col.value -> 'panes') = 'array'`);
    // ...and a pane's kind/target come from `scope`, whose absence (an
    // unbound picker pane, or a legacy shape) yields NULLs via the `->`/`->>`
    // chain rather than a failure. The legacy `tabs` field is never read.
    expect(code).toContain(`pane.value -> 'scope' ->> 'kind'`);
    expect(code).toContain(`pane.value -> 'scope' ->> 'targetId'`);
    expect(code).not.toContain(`'tabs'`);
  });

  it('should DEDUPLICATE client-minted ids before insert, not lean on ON CONFLICT to hide collisions', () => {
    // The blob has never constrained pane/column id uniqueness while the row
    // tables are keyed `(workspaceId, id)`. Without `DISTINCT ON` the second
    // occurrence is silently swallowed by `ON CONFLICT DO NOTHING` and 0252
    // then refuses to drop the column over the pane this migration ate.
    expect(code).toContain(`SELECT DISTINCT ON (s."id", col.value ->> 'id')`);
    expect(code).toContain(`SELECT DISTINCT ON (s."id", pane.value ->> 'id')`);
    // First occurrence wins, in the client's own read order.
    expect(code).toContain(`ORDER BY s."id", col.value ->> 'id', col.ordinality`);
    expect(code).toContain(`ORDER BY s."id", pane.value ->> 'id', col.ordinality, pane.ordinality`);
    // And a collapse is reported rather than silent.
    expect(code).toMatch(/RAISE WARNING[^;]*duplicate pane id/);
  });

  it('should be strictly additive — 0247 EXPANDS only; the blob is dropped later, by 0252', () => {
    expect(code).not.toContain('DROP COLUMN');
    expect(code).not.toContain('DROP TABLE');
    expect(code).not.toMatch(/\bRENAME\b/);
    expect(code).not.toMatch(/^\s*(UPDATE|DELETE FROM|TRUNCATE)\b/m);
  });
});
