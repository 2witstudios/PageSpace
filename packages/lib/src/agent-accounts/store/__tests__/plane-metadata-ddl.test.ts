/**
 * Drift guard between the plane metadata DDL (`infisical-dev/plane-metadata.sql`,
 * the one owner of this shape per Control Board §1) and
 * `plane-metadata-repository.ts`, the only code that reads/writes that table.
 * A column the repository references but the DDL does not declare would
 * otherwise surface only as a runtime Postgres error against a real instance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SQL_PATH = path.join(__dirname, '../infisical-dev/plane-metadata.sql');
const REPOSITORY_PATH = path.join(__dirname, '../plane-metadata-repository.ts');

function ddlColumns(sql: string): readonly string[] {
  const match = sql.match(/CREATE TABLE[^(]*\(([\s\S]*)\);/);
  if (!match) throw new Error('plane-metadata.sql: could not find a CREATE TABLE(...) block to parse');
  const body = match[1];
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toUpperCase().startsWith('PRIMARY KEY'))
    .map((line) => line.split(/\s+/)[0].replace(/,$/, ''));
}

describe('plane metadata DDL matches the repository that reads/writes it', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const repositorySource = readFileSync(REPOSITORY_PATH, 'utf8');
  const columns = ddlColumns(sql);

  it('given plane-metadata.sql, should declare the table agent_account_secret_versions', () => {
    expect(sql).toContain('agent_account_secret_versions');
  });

  // Every snake_case column plane-metadata-repository.ts references in a query must be a real
  // DDL column — a name the repository invents that the DDL never declared would compile fine
  // and fail only against a real Postgres.
  it.each(['tenant_id', 'account_id', 'kind', 'current_version', 'previous_version', 'bindings', 'rotated_at', 'revoked_at', 'created_at'] as const)(
    'given the repository reads/writes column %s, should exist in plane-metadata.sql',
    (column) => {
      expect(repositorySource).toContain(column);
      expect(columns).toContain(column);
    },
  );
});
