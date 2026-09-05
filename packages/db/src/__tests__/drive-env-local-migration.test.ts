/**
 * Static invariants of the local-environments migrations (Local Environments
 * epic, M1 · t05): `substrate` on `drive_envs`, its CHECKs and the composite-FK
 * target, and the `drive_env_local` sibling.
 *
 * TWO generated files, deliberately. Postgres requires the UNIQUE that a
 * composite FK references to exist BEFORE the FK, and drizzle-kit emits
 * `ADD CONSTRAINT … FOREIGN KEY` ahead of `ADD CONSTRAINT … UNIQUE` when both
 * land in one diff — a single generated file failed to apply against a real
 * Postgres ("no unique constraint matching given keys"). So 0281 carries the
 * column, the unique target and the CHECKs, and 0282 carries the sibling table
 * and its composite FK. Both are drizzle-kit output (generated with the sibling
 * temporarily hidden from the aggregator, then restored), never hand-edited,
 * and `db:migrate` applies them in order in one invocation.
 *
 * Pins the SQL so CI catches a regenerated migration losing the default (which
 * is what lets the CHECKs ship VALID on a populated table), the cascade, the
 * ordering, or the strictly-ADDITIVE guarantee — without a database. Live
 * behaviour is exercised in `drive-env-local.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

function load(idx: number) {
  const prefix = String(idx).padStart(4, '0');
  const file = readdirSync(MIGRATIONS_DIR).find((f) => new RegExp(`^${prefix}_.*\\.sql$`).test(f));
  const sql = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : '';
  /** SQL with line comments stripped, so assertions never match prose. */
  const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  return { file, code };
}

const first = load(281);
const second = load(282);
const both = `${first.code}\n${second.code}`;

describe('drizzle/0281 + 0282 local environments (substrate, then drive_env_local)', () => {
  it('should exist in the journal as 281 and 282, in that order', () => {
    expect(first.file, 'no 0281_*.sql — run db:generate').toBeDefined();
    expect(second.file, 'no 0282_*.sql — run db:generate').toBeDefined();
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 281)?.tag).toBe(path.basename(first.file ?? '', '.sql'));
    expect(journal.entries.find((e) => e.idx === 282)?.tag).toBe(path.basename(second.file ?? '', '.sql'));
  });

  describe('0281 — the column, the FK target, the CHECKs', () => {
    it("should add drive_envs.substrate as text NOT NULL DEFAULT 'sprite' — the default is what makes the CHECK valid on a populated table", () => {
      expect(first.code).toMatch(/ALTER TABLE "drive_envs" ADD COLUMN "substrate" text DEFAULT 'sprite' NOT NULL/);
    });

    it('should add UNIQUE (id, substrate) — the composite-FK target — BEFORE any FK references it', () => {
      expect(first.code).toMatch(/ADD CONSTRAINT "drive_envs_id_substrate_unique" UNIQUE\("id","substrate"\)/);
      expect(first.code).not.toMatch(/FOREIGN KEY/);
    });

    it('should add drive_envs_local_no_sprite_check forbidding any Sprite pointer on a local row, and the closed-set check', () => {
      expect(first.code).toContain('ADD CONSTRAINT "drive_envs_local_no_sprite_check" CHECK (');
      const check = first.code.slice(first.code.indexOf('drive_envs_local_no_sprite_check'));
      expect(check).toMatch(/"substrate" = 'sprite'/);
      expect(check).toMatch(/"spriteKey" IS NULL/);
      expect(check).toMatch(/"sandboxId" IS NULL/);
      expect(check).toMatch(/"spriteInstanceId" IS NULL/);
      expect(first.code).toMatch(/ADD CONSTRAINT "drive_envs_substrate_check" CHECK \("drive_envs"\."substrate" IN \('sprite', 'local'\)\)/);
    });

    it('should ship the CHECKs VALID (no NOT VALID staging is needed thanks to the default)', () => {
      expect(both).not.toMatch(/NOT VALID/);
    });
  });

  describe('0282 — the sibling and its composite FK', () => {
    it('should create drive_env_local keyed by envId with a COMPOSITE cascading FK (envId, substrate) → drive_envs (id, substrate)', () => {
      expect(second.code).toContain('CREATE TABLE "drive_env_local"');
      expect(second.code).toMatch(/"envId" text PRIMARY KEY NOT NULL/);
      expect(second.code).toMatch(/FOREIGN KEY \("envId","substrate"\) REFERENCES "public"\."drive_envs"\("id","substrate"\) ON DELETE cascade/);
      expect(both).not.toMatch(/FOREIGN KEY \("envId"\) REFERENCES/);
    });

    it("should pin the sibling's substrate to 'local' (the second half of the FK)", () => {
      expect(second.code).toMatch(/"substrate" text DEFAULT 'local' NOT NULL/);
      expect(second.code).toMatch(/CONSTRAINT "drive_env_local_substrate_check" CHECK \("drive_env_local"\."substrate" = 'local'\)/);
    });

    it('should make enrollmentId unique', () => {
      expect(second.code).toMatch(/UNIQUE\("enrollmentId"\)/);
    });

    it("should default bindPolicy to 'owner' and serverPolicy to a deny-by-default object", () => {
      expect(second.code).toMatch(/"bindPolicy" text DEFAULT 'owner' NOT NULL/);
      expect(second.code).toMatch(/"serverPolicy" jsonb DEFAULT '\{"ops":\[\],"checkpoint":false\}'::jsonb NOT NULL/);
      expect(second.code).toMatch(/CONSTRAINT "drive_env_local_bind_policy_check" CHECK/);
    });
  });

  it('should be strictly ADDITIVE across both: no DROP of any kind, no touch of agent_workspaces or its env_no_sprite check', () => {
    expect(both).not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    expect(both).not.toMatch(/agent_workspaces/);
    expect(both).not.toContain('agent_workspaces_env_no_sprite_check');
  });

  it('should not backfill or rewrite existing rows (the default covers them)', () => {
    // Statement-level only: `ON DELETE cascade` / `ON UPDATE no action` in the FK are clauses, not writes.
    expect(both).not.toMatch(/^\s*UPDATE\s+"/m);
    expect(both).not.toMatch(/^\s*DELETE\s+FROM\b/m);
    expect(both).not.toMatch(/^\s*INSERT\s+INTO\b/m);
  });
});
