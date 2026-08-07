/**
 * Static invariants of the conversations.rev migration (Agent-Session Single
 * Source of Truth epic, Phase 2 — docs/2.0-architecture/agent-sessions.md §3).
 *
 * `rev` is the per-conversation monotonic revision counter every durable
 * message/conversation mutation bumps in-transaction; every
 * `conversation:*` event carries the post-write value so subscribers can
 * prove they are current (apply on watermark+1, refetch on a gap).
 *
 * Deploy-order safety is the load-bearing property this pins: Fly runs
 * migrations before rolling web, so OLD web code briefly runs against the
 * NEW schema. The column must therefore be purely additive with a DEFAULT —
 * an INSERT from old code that never mentions `rev` must succeed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(MIGRATIONS_DIR).find((f) => /^0248_.*\.sql$/.test(f));
const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle/0248 conversations.rev migration', () => {
  it('should exist in the journal as migration 0248', () => {
    expect(migrationFile).toBeDefined();
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((e) => e.idx === 248);
    expect(entry?.tag).toBe(migrationFile?.replace(/\.sql$/, ''));
  });

  it('should add rev to conversations as bigint DEFAULT 0 NOT NULL', () => {
    expect(code).toContain(
      'ALTER TABLE "conversations" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;',
    );
  });

  it('is expand-only: a DEFAULT exists, so old-code INSERTs that never mention rev still succeed', () => {
    // NOT NULL without DEFAULT would break every in-flight old-web INSERT
    // during the rolling-deploy window.
    expect(code).toMatch(/"rev" bigint DEFAULT 0 NOT NULL/);
  });

  it('should touch nothing else — one additive statement, no drops, no other tables', () => {
    expect(code).not.toContain('DROP');
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
    const statements = code
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0].startsWith('ALTER TABLE "conversations"')).toBe(true);
  });
});
