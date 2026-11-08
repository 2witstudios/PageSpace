#!/usr/bin/env bun
/**
 * Destructive-migration CI gate.
 *
 * Fails if a migration file ADDED in this diff (compared to a base ref, across both
 * packages/db/drizzle and the drizzle-admin trust-plane migrations) contains a
 * destructive SQL statement — DROP TABLE/COLUMN/TYPE, TRUNCATE, a column type
 * change, an enum-swap rename, or a NOT NULL column added without a DEFAULT —
 * without a `-- destructive-migration-ack: <reason>` comment anywhere in the file.
 *
 * Scope: per-file only, and only for newly added files — existing migrations are
 * never retroactively flagged. A destructive operation split across two separate
 * migration files (e.g. a TRUNCATE in migration N enabling a NOT-NULL-without-
 * default in migration N+1) is out of scope for this check.
 *
 * Usage: bun scripts/check-destructive-migrations.ts <base-ref>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// drizzle-admin holds the trust-plane admin DB migrations, run via `db:migrate:admin`
// when ADMIN_DB_MIGRATIONS_ENABLED=true (see docker-images.yml) — a destructive
// migration there is just as dangerous as one in the main drizzle dir.
const MIGRATIONS_DIRS = ['packages/db/drizzle', 'packages/db/drizzle-admin'];
// The reason must be on the same line as the marker — `\s` would also match a
// newline, letting an empty `ack:` line "borrow" non-whitespace from whatever
// text happens to follow it (e.g. the next line's SQL).
export const ACK_PATTERN = /--\s*destructive-migration-ack:[ \t]*\S/i;

export const DESTRUCTIVE_CHECKS: { name: string; test: (stmt: string) => boolean }[] = [
  { name: 'DROP TABLE', test: (s) => /\bDROP\s+TABLE\b/i.test(s) },
  { name: 'DROP COLUMN', test: (s) => /\bDROP\s+COLUMN\b/i.test(s) },
  { name: 'TRUNCATE', test: (s) => /\bTRUNCATE\b/i.test(s) },
  { name: 'DROP TYPE', test: (s) => /\bDROP\s+TYPE\b/i.test(s) },
  { name: 'enum-swap rename (RENAME TO ..._old)', test: (s) => /RENAME\s+TO\s+"?\w+_old"?/i.test(s) },
  { name: 'ALTER COLUMN ... TYPE (data type change)', test: (s) => /\bALTER\s+COLUMN\b.*\bTYPE\b/i.test(s) },
  {
    name: 'ADD COLUMN ... NOT NULL without a DEFAULT',
    test: (s) =>
      /\bADD\s+COLUMN\b/i.test(s) &&
      /\bNOT\s+NULL\b/i.test(s) &&
      !/\bDEFAULT\b/i.test(s) &&
      !/\b(BIG)?SERIAL\b/i.test(s), // serial/bigserial self-populate via an implicit sequence default
  },
];

function addedMigrationFiles(baseRef: string): string[] {
  const output = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=A',
      `${baseRef}...HEAD`,
      '--',
      ...MIGRATIONS_DIRS.map((dir) => `${dir}/*.sql`),
    ],
    { encoding: 'utf-8' }
  );
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function statementsOf(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Strip `--` line comments and `/* */` block comments before testing a statement
// against DESTRUCTIVE_CHECKS. Without this, an explanatory comment that happens to
// contain a keyword — e.g. `-- table is empty, no DEFAULT needed` above an
// `ADD COLUMN ... NOT NULL` — satisfies the DEFAULT/SERIAL regex and lets a genuinely
// destructive statement through unacknowledged.
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

export function findDestructiveReasons(sql: string): string[] {
  const reasons = new Set<string>();
  for (const stmt of statementsOf(sql)) {
    const stripped = stripSqlComments(stmt);
    for (const check of DESTRUCTIVE_CHECKS) {
      if (check.test(stripped)) reasons.add(check.name);
    }
  }
  return [...reasons];
}

export function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error('Usage: bun scripts/check-destructive-migrations.ts <base-ref>');
    process.exit(2);
  }

  const files = addedMigrationFiles(baseRef);
  if (files.length === 0) {
    console.log('No new migration files in this diff.');
    return;
  }

  let failed = false;
  for (const file of files) {
    const sql = readFileSync(file, 'utf-8');
    const reasons = findDestructiveReasons(sql);
    if (reasons.length === 0) {
      console.log(`OK  ${file} (no destructive patterns)`);
      continue;
    }
    if (ACK_PATTERN.test(sql)) {
      console.log(`OK  ${file} (destructive: ${reasons.join(', ')} — acknowledged)`);
      continue;
    }
    failed = true;
    console.error(`FAIL  ${file}`);
    console.error(`      Destructive pattern(s) found: ${reasons.join(', ')}`);
    console.error(
      '      Add a leading comment acknowledging expand/contract review, e.g.:'
    );
    console.error(
      '        -- destructive-migration-ack: <why this is safe, or what old code it may break>'
    );
  }

  if (failed) {
    console.error(
      '\nDestructive migration(s) added without an ack comment. See errors above.'
    );
    process.exit(1);
  }
}

// Only run if executed directly (not imported by tests)
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('check-destructive-migrations.ts')) {
  main();
}
