/**
 * `drive_env_grant_audit` — the server side of the local-env grant audit
 * (Local Environments epic, GA wave 3, invariant 10). Schema-level pins,
 * without a database: the columns the leaf page names, the two CHECKs that
 * make the row self-describing, the partial unique on `grantId`, and the
 * cascade/erasure behaviour of the two FKs. The constraints are exercised
 * against a real Postgres in `@pagespace/lib`'s
 * `grant-audit-store.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { driveEnvGrantAudit, DRIVE_ENV_GRANT_AUDIT_OPS, DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS } from '../drive-env-grant-audit';

const config = getTableConfig(driveEnvGrantAudit);
const columns = getTableColumns(driveEnvGrantAudit);

function checkSql(name: string): string {
  const found = config.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no CHECK named ${name}`);
  return new PgDialect().sqlToQuery(found.value).sql;
}

describe('drive_env_grant_audit — columns', () => {
  it('holds the leaf page\'s column set: {envId, grantId, userId, sessionId, conversationId, op, argsHash, verdict, exitCode, ts} plus the click and the summary', () => {
    for (const name of ['envId', 'grantId', 'userId', 'sessionId', 'conversationId', 'op', 'argsHash', 'verdict', 'exitCode', 'ts', 'resultAt', 'summary', 'challengeId', 'approvalScope']) {
      expect(columns[name as keyof typeof columns], name).toBeDefined();
    }
  });

  it('grantId is NULLABLE (a refusal never mints one) while the principal facts and the summary are NOT NULL', () => {
    expect(columns.grantId.notNull).toBe(false);
    expect(columns.sessionId.notNull).toBe(true);
    expect(columns.conversationId.notNull).toBe(true);
    expect(columns.argsHash.notNull).toBe(true);
    expect(columns.summary.notNull).toBe(true);
    expect(columns.verdict.notNull).toBe(true);
    expect(columns.ts.hasDefault).toBe(true);
    expect(columns.resultAt.notNull).toBe(false);
  });

  it('the op set is the wire vocabulary (equal to lib\'s `GRANT_OPS` — pinned from the lib side, which may import this package) and the CHECK is built from it', () => {
    expect([...DRIVE_ENV_GRANT_AUDIT_OPS]).toEqual(['exec', 'fs_read', 'fs_write', 'pty_open']);
    expect(checkSql('drive_env_grant_audit_op_check')).toContain(`IN (${DRIVE_ENV_GRANT_AUDIT_OPS.map((op) => `'${op}'`).join(', ')})`);
  });

  it('"has a grant id" and "was signed" are the same fact: the CHECK ties grantId IS NULL to verdict LIKE refused:%', () => {
    const sql = checkSql('drive_env_grant_audit_grant_id_refused_check');
    expect(sql).toContain('"grantId" IS NULL');
    expect(sql).toContain("LIKE 'refused:%'");
    expect(sql).toMatch(/\) = \(/);
  });

  it('exports the summary bound the lib store clips to', () => {
    expect(DRIVE_ENV_GRANT_AUDIT_SUMMARY_MAX_CHARS).toBe(512);
  });
});

describe('drive_env_grant_audit — indexes and keys', () => {
  it('one row per grant: a UNIQUE index on grantId, PARTIAL so refused rows (NULL) never collide', () => {
    const unique = config.indexes.find((i) => i.config.name === 'drive_env_grant_audit_grant_id_unique');
    expect(unique).toBeDefined();
    expect(unique!.config.unique).toBe(true);
    expect(unique!.config.where).toBeDefined();
  });

  it('the two reads have their indexes: (envId, ts) for the activity panel and (userId, ts) for the account page', () => {
    const names = config.indexes.map((i) => i.config.name);
    expect(names).toContain('drive_env_grant_audit_env_ts_idx');
    expect(names).toContain('drive_env_grant_audit_user_ts_idx');
  });

  it('envId cascades with the env; userId is SET NULL on erasure (the machine\'s history outlives its requester)', () => {
    const fks = config.foreignKeys.map((fk) => ({ columns: fk.reference().columns.map((c) => c.name), onDelete: fk.onDelete }));
    expect(fks).toContainEqual({ columns: ['envId'], onDelete: 'cascade' });
    expect(fks).toContainEqual({ columns: ['userId'], onDelete: 'set null' });
  });
});
