/**
 * user_builtin_agents — the per-user pointer from a built-in agent key
 * (`imago`, `imago-planner`, `imago-researcher`) to the AI_CHAT page that
 * embodies it in the user's Home drive. Schema-level proof of the declaration
 * and of the generated migration; the behavioural proof (the unique index
 * refuses a second row, both cascades fire) is
 * `../../__tests__/user-builtin-agents.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { userBuiltinAgents } from '../user-builtin-agents';
import { schema } from '../../schema';

const config = getTableConfig(userBuiltinAgents);
const columns = getTableColumns(userBuiltinAgents);

function fkOnColumn(columnName: string) {
  const fk = config.foreignKeys.find((candidate) =>
    candidate.reference().columns.some((column) => column.name === columnName)
  );
  expect(fk, `expected a foreign key on ${columnName}`).toBeDefined();
  return fk!;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../drizzle');

function migrationCreatingTable(): { file: string; sql: string } {
  const matches = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }))
    .filter(({ sql }) => sql.includes('CREATE TABLE "user_builtin_agents"'));
  expect(matches.map(({ file }) => file), 'exactly one migration creates user_builtin_agents').toHaveLength(1);
  return matches[0]!;
}

describe('user_builtin_agents schema', () => {
  it('given a pointer table, should be named user_builtin_agents with NOT NULL userId, key and pageId', () => {
    expect(config.name).toBe('user_builtin_agents');
    expect(columns.id.primary).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.key.notNull).toBe(true);
    expect(columns.key.dataType).toBe('string');
    expect(columns.pageId.notNull).toBe(true);
  });

  it('given the user owns the pointer, should CASCADE from users', () => {
    const fk = fkOnColumn('userId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('users');
    expect(fk.onDelete).toBe('cascade');
  });

  it('given the pointer names a page, should CASCADE from pages so no row outlives its agent', () => {
    const fk = fkOnColumn('pageId');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('pages');
    expect(fk.onDelete).toBe('cascade');
  });

  it('given one agent per key per user, should make (userId, key) unique', () => {
    const unique = config.indexes.find((index) => index.config.name === 'user_builtin_agents_user_key_idx');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name)).toEqual(['userId', 'key']);
  });

  it('given page deletes cascade into this table, should index pageId', () => {
    const index = config.indexes.find((candidate) => candidate.config.name === 'user_builtin_agents_page_idx');
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual(['pageId']);
  });

  it('given the schema entry, should export the table in the combined schema', () => {
    expect(schema.userBuiltinAgents).toBe(userBuiltinAgents);
  });
});

describe('user_builtin_agents migration', () => {
  it('given bun run db:generate, should create the table, both cascading FKs and the unique index', () => {
    const { sql } = migrationCreatingTable();
    expect(sql).toMatch(/FOREIGN KEY \("userId"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/);
    expect(sql).toMatch(/FOREIGN KEY \("pageId"\) REFERENCES "public"\."pages"\("id"\) ON DELETE cascade/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "user_builtin_agents_user_key_idx" ON "user_builtin_agents" USING btree \("userId","key"\)/);
  });

  it('given the journal, should register the migration under its own tag', () => {
    const { file } = migrationCreatingTable();
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tag = file.replace(/\.sql$/, '');
    const entries = journal.entries.filter((entry) => entry.tag === tag);
    expect(entries).toHaveLength(1);
    // Generated last on the base journal: nothing was appended after it by hand.
    expect(journal.entries.at(-1)?.tag).toBe(tag);
  });
});
