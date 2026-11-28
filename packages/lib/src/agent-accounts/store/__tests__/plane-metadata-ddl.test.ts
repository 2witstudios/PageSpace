/**
 * Drift guard between the plane metadata DDL (the ordered files in `plane-metadata/`,
 * the one owner of this shape per Control Board §1) and
 * `plane-metadata-repository.ts`, the only code that reads/writes that table.
 * A column the repository references but the DDL does not declare would
 * otherwise surface only as a runtime Postgres error against a real instance.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(__dirname, '../plane-metadata');
const REPOSITORY_PATH = path.join(__dirname, '../plane-metadata-repository.ts');

/** Every column declared across every CREATE TABLE block in the file. */
function ddlColumns(sql: string): readonly string[] {
  const blocks = [...sql.matchAll(/CREATE TABLE[^(]*\(([\s\S]*?)\n\);/g)];
  if (blocks.length === 0) throw new Error('plane-metadata.sql: could not find a CREATE TABLE(...) block in plane-metadata/*.sql');
  return blocks.flatMap((block) =>
    block[1]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.toUpperCase().startsWith('PRIMARY KEY') && !line.startsWith('--'))
      .map((line) => line.split(/\s+/)[0]!.replace(/,$/, '')),
  );
}

describe('plane metadata DDL matches the repository that reads/writes it', () => {
  // Every migration, in order: the schema the runner leaves is the union of them.
  const sql = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort().map((name) => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')).join('\n');
  const repositorySource = readFileSync(REPOSITORY_PATH, 'utf8');
  const columns = ddlColumns(sql);

  it('given the plane-metadata migrations, should declare the secret versions table and the bindings row table (G1c R4)', () => {
    const actual = ['agent_account_secret_versions', 'agent_account_plane_bindings'].map((table) => sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
    expect(actual).toEqual([true, true]);
  });

  // Every snake_case column plane-metadata-repository.ts references in a query must be a real
  // DDL column — a name the repository invents that the DDL never declared would compile fine
  // and fail only against a real Postgres.
  it.each([
    'tenant_id',
    'account_id',
    'kind',
    'current_version',
    'previous_version',
    'rotated_at',
    'revoked_at',
    'revoke_reason',
    'pending_version',
    'pending_digest',
    'pending_rotation',
    'created_at',
    'bindings',
    'scope',
    'consenters',
    'policy_version',
  ] as const)(
    'given the repository reads/writes column %s, should exist in the plane-metadata migrations',
    (column) => {
      expect(repositorySource).toContain(column);
      expect(columns).toContain(column);
    },
  );
});
