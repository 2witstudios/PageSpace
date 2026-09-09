/**
 * `drive_env_approvals` — the server's MIRROR of a local env's durable
 * approvals (GA wave 3, leaf 5). Schema-level pins without a database: the
 * durable-only scope set, the CHECK that an ack cannot exist without a revoke
 * decision, the two listing indexes, and the FK behaviour. Exercised against
 * a real Postgres in `@pagespace/lib`'s `approval-mirror-store.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { driveEnvApprovals, DRIVE_ENV_APPROVAL_SCOPES } from '../drive-env-approvals';

const config = getTableConfig(driveEnvApprovals);
const columns = getTableColumns(driveEnvApprovals);

function checkSql(name: string): string {
  const found = config.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no CHECK named ${name}`);
  return new PgDialect().sqlToQuery(found.value).sql;
}

describe('drive_env_approvals — columns', () => {
  it('the id IS the approval id (no generated key): what the machine file and a revoke both name', () => {
    expect(columns.id.primary).toBe(true);
    expect(columns.id.hasDefault).toBe(false);
  });

  it('the durable scope set excludes `once` and the CHECK is built from it', () => {
    expect([...DRIVE_ENV_APPROVAL_SCOPES]).toEqual(['session', '30d', 'until_revoked']);
    expect(checkSql('drive_env_approvals_scope_check')).toContain(`IN (${DRIVE_ENV_APPROVAL_SCOPES.map((s) => `'${s}'`).join(', ')})`);
  });

  it('an ack cannot exist without a revoke decision: revokeAcknowledgedAt IS NULL OR revokedAt IS NOT NULL', () => {
    const sql = checkSql('drive_env_approvals_ack_needs_revoke_check');
    expect(sql).toContain('"revokeAcknowledgedAt" IS NULL');
    expect(sql).toContain('"revokedAt" IS NOT NULL');
  });

  it('the decision and the ack are separate columns, both nullable, with the machine\'s count beside the ack', () => {
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.revokeAcknowledgedAt.notNull).toBe(false);
    expect(columns.revokeRemoved.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.createdAt.hasDefault).toBe(false);
  });
});

describe('drive_env_approvals — indexes and keys', () => {
  it('the env and user listings have their indexes', () => {
    const names = config.indexes.map((i) => i.config.name);
    expect(names).toContain('drive_env_approvals_env_idx');
    expect(names).toContain('drive_env_approvals_user_idx');
  });

  it('envId cascades with the env; userId is SET NULL on erasure', () => {
    const fks = config.foreignKeys.map((fk) => ({ columns: fk.reference().columns.map((c) => c.name), onDelete: fk.onDelete }));
    expect(fks).toContainEqual({ columns: ['envId'], onDelete: 'cascade' });
    expect(fks).toContainEqual({ columns: ['userId'], onDelete: 'set null' });
  });
});
