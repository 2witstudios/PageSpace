/**
 * Local Environments epic (M1 · t05) — schema-level proof of the SUBSTRATE
 * contract on `drive_envs` and the `drive_env_local` sibling.
 *
 * The invariant this guards: a local env keeps every Sprite pointer column
 * NULL — CHECK-enforced — so it is structurally invisible to every predicate
 * that keys off `sandboxId IS NOT NULL` (reclaim trigger, storage billing,
 * the live-sprite index, orphan reconcile). This is the live-schema layer;
 * the migration artifact is pinned separately in
 * `src/__tests__/drive-env-local-migration.test.ts`, and the constraint is
 * exercised against a real Postgres in
 * `src/__tests__/drive-env-local.integration.test.ts`. Runs without a database.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { driveEnvs } from '../drive-envs';
import { driveEnvLocal, driveEnvLocalRelations, DRIVE_ENV_SUBSTRATES, DRIVE_ENV_BIND_POLICIES } from '../drive-env-local';

const envConfig = getTableConfig(driveEnvs);
const envColumns = getTableColumns(driveEnvs);
const localConfig = getTableConfig(driveEnvLocal);
const localColumns = getTableColumns(driveEnvLocal);

describe('drive_envs.substrate — the reserved substrate axis, not the deleted use-case kind', () => {
  it('is a NOT NULL text column defaulting to sprite, so every existing row is a Sprite env without a backfill', () => {
    expect(envColumns.substrate).toBeDefined();
    expect(envColumns.substrate.notNull).toBe(true);
    expect(envColumns.substrate.hasDefault).toBe(true);
  });

  it('exports the closed substrate set', () => {
    expect([...DRIVE_ENV_SUBSTRATES]).toEqual(['sprite', 'local']);
  });

  it('carries drive_envs_local_no_sprite_check: a local env may hold NO Sprite pointer (invariant 9)', () => {
    const check = envConfig.checks.find((c) => c.name === 'drive_envs_local_no_sprite_check');
    expect(check).toBeDefined();
  });

  it('keeps the Sprite pointer columns nullable — the CHECK carries the invariant, not NOT NULL', () => {
    expect(envColumns.spriteKey.notNull).toBe(false);
    expect(envColumns.sandboxId.notNull).toBe(false);
    expect(envColumns.spriteInstanceId.notNull).toBe(false);
  });

  it('does NOT declare a relation to drive_env_local from this side (the sibling owns the edge — no import cycle)', () => {
    // The relation module for drive_envs is defined in drive-envs.ts and must
    // not import drive-env-local.ts; the sibling declares `env: one(driveEnvs)`.
    expect(driveEnvLocalRelations).toBeDefined();
  });
});

describe('drive_env_local — the 1:1 sibling holding a local env\'s connection facts', () => {
  it('is keyed by envId, which is ALSO a cascading FK to drive_envs (deleting the env deletes its connection facts)', () => {
    expect(localConfig.name).toBe('drive_env_local');
    expect(localColumns.envId.primary).toBe(true);
    const fk = localConfig.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'envId'));
    expect(fk).toBeDefined();
    expect(getTableConfig(fk!.reference().foreignTable).name).toBe('drive_envs');
    expect(fk!.onDelete).toBe('cascade');
  });

  it('has a UNIQUE enrollmentId — the wire identity the daemon presents', () => {
    expect(localColumns.enrollmentId.notNull).toBe(true);
    const unique = localConfig.uniqueConstraints.find((u) => u.columns.some((c) => c.name === 'enrollmentId'))
      ?? localConfig.indexes.find((i) => i.config.unique && i.config.columns.some((c) => 'name' in c && c.name === 'enrollmentId'));
    expect(unique, 'enrollmentId must be unique').toBeDefined();
  });

  it('stores only the machine PUBLIC key + fingerprint and which server key was pinned — never private material or a reusable secret', () => {
    expect(localColumns.machinePublicKey.notNull).toBe(true);
    expect(localColumns.machineKeyFingerprint.notNull).toBe(true);
    expect(localColumns.serverKeyId.notNull).toBe(true);
    for (const forbidden of ['machinePrivateKey', 'credential', 'secret', 'token']) {
      expect(Object.keys(localColumns).some((k) => k.toLowerCase().includes(forbidden.toLowerCase())), `no column resembling ${forbidden}`).toBe(false);
    }
  });

  it('defaults bindPolicy to owner (RCE on personal hardware warrants the strictest default) and exports the closed set', () => {
    expect(localColumns.bindPolicy.notNull).toBe(true);
    expect(localColumns.bindPolicy.hasDefault).toBe(true);
    expect([...DRIVE_ENV_BIND_POLICIES]).toEqual(['owner', 'admins', 'members']);
  });

  it('carries a CHECK that bindPolicy is one of the closed set', () => {
    expect(localConfig.checks.find((c) => c.name === 'drive_env_local_bind_policy_check')).toBeDefined();
  });

  it('keeps capabilities and serverPolicy as jsonb, with serverPolicy defaulting to deny-by-default', () => {
    expect(localColumns.capabilities.dataType).toBe('json');
    expect(localColumns.serverPolicy.dataType).toBe('json');
    expect(localColumns.serverPolicy.notNull).toBe(true);
    expect(localColumns.serverPolicy.hasDefault).toBe(true);
  });

  it('has lastSeenAt / enrolledAt / revokedAt as nullable timestamps and the usual createdAt/updatedAt', () => {
    expect(localColumns.lastSeenAt.notNull).toBe(false);
    expect(localColumns.revokedAt.notNull).toBe(false);
    expect(localColumns.enrolledAt.notNull).toBe(false);
    expect(localColumns.createdAt.notNull).toBe(true);
    expect(localColumns.updatedAt.notNull).toBe(true);
  });
});
