/**
 * Static invariants of the local-environments migration (Local Environments
 * epic, M1 · t05): the `substrate` column on `drive_envs`, its CHECK, and the
 * `drive_env_local` sibling table.
 *
 * Pins the migration SQL itself so CI catches a regenerated or hand-edited
 * migration losing the default (which is what lets the CHECK ship VALID on a
 * populated table), the cascade, or the strictly-ADDITIVE guarantee — without
 * a database. drizzle-kit re-emits every check from the snapshot on
 * regenerate, so the negative assertions here are what stop it from quietly
 * dropping and recreating `agent_workspaces_env_no_sprite_check`.
 *
 * Live behaviour (the CHECK actually refusing a Sprite pointer on a local
 * row, the cascade) is exercised in `drive-env-local.integration.test.ts`
 * against a real Postgres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const MIGRATION_IDX = 281;
const PREFIX = String(MIGRATION_IDX).padStart(4, '0');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => new RegExp(`^${PREFIX}_.*\\.sql$`).test(f));
const sql = migrationFile ? readFileSync(path.join(MIGRATIONS_DIR, migrationFile), 'utf8') : '';
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe(`drizzle/${PREFIX} local environments (substrate + drive_env_local)`, () => {
  it(`should exist in the journal as migration ${MIGRATION_IDX}`, () => {
    expect(migrationFile, `no ${PREFIX}_*.sql — run db:generate`).toBeDefined();
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === MIGRATION_IDX)?.tag).toBe(path.basename(migrationFile ?? '', '.sql'));
  });

  it("should add drive_envs.substrate as text NOT NULL DEFAULT 'sprite' — the default is what makes the CHECK valid on a populated table", () => {
    expect(code).toMatch(/ALTER TABLE "drive_envs" ADD COLUMN "substrate" text DEFAULT 'sprite' NOT NULL/);
  });

  it('should add drive_envs_local_no_sprite_check forbidding any Sprite pointer on a local row', () => {
    expect(code).toContain('ADD CONSTRAINT "drive_envs_local_no_sprite_check" CHECK (');
    const check = code.slice(code.indexOf('drive_envs_local_no_sprite_check'));
    expect(check).toMatch(/"substrate" = 'sprite'/);
    expect(check).toMatch(/"spriteKey" IS NULL/);
    expect(check).toMatch(/"sandboxId" IS NULL/);
    expect(check).toMatch(/"spriteInstanceId" IS NULL/);
  });

  it('should ship the CHECK VALID (no NOT VALID staging is needed thanks to the default)', () => {
    expect(code).not.toMatch(/NOT VALID/);
  });

  it('should create drive_env_local keyed by envId with a cascading FK to drive_envs', () => {
    expect(code).toContain('CREATE TABLE "drive_env_local"');
    expect(code).toMatch(/"envId" text PRIMARY KEY NOT NULL/);
    expect(code).toMatch(/FOREIGN KEY \("envId"\) REFERENCES "public"\."drive_envs"\("id"\) ON DELETE cascade/);
  });

  it('should make enrollmentId unique', () => {
    expect(code).toMatch(/UNIQUE\("enrollmentId"\)|CREATE UNIQUE INDEX "[a-z_]+" ON "drive_env_local" USING btree \("enrollmentId"\)/);
  });

  it("should default bindPolicy to 'owner' and serverPolicy to a deny-by-default object", () => {
    expect(code).toMatch(/"bindPolicy" text DEFAULT 'owner' NOT NULL/);
    expect(code).toMatch(/"serverPolicy" jsonb DEFAULT '\{"ops":\[\],"checkpoint":false\}'::jsonb NOT NULL/);
  });

  it('should be strictly ADDITIVE: no DROP of any kind, and no touch of agent_workspaces or its env_no_sprite check', () => {
    expect(code).not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(code).not.toMatch(/agent_workspaces/);
    expect(code).not.toContain('agent_workspaces_env_no_sprite_check');
  });

  it('should not backfill or rewrite existing rows (the default covers them)', () => {
    // Statement-level only: `ON DELETE cascade` / `ON UPDATE no action` in the FK are clauses, not writes.
    expect(code).not.toMatch(/^\s*UPDATE\s+"/m);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/m);
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/m);
  });
});
