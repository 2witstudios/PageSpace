/**
 * `dev_preview_services` — schema-level proof of the invariants the preview
 * decision core and the proxy task are allowed to assume. Runs without a
 * database: it asserts the Drizzle declarations the migration was generated
 * from.
 *
 * The four that must never silently regress:
 *
 *  - **Keyed to the Sprite INSTANCE, one row per instance.** `spriteInstanceId`
 *    is NOT NULL and UNIQUE. If it goes nullable a row can exist that no
 *    reader can prove describes the VM in front of it; if it loses UNIQUE two
 *    relays can claim one 8080.
 *  - **One row per holder.** The partial unique indexes on `workspaceId` and
 *    `envId` are the upsert's conflict targets; without them a rebuilt env
 *    accumulates one dead-instance row per rebuild and "re-create replaces"
 *    is a lie.
 *  - **Exactly one holder, both cascading.** A session's preview dies with
 *    the session and an env's with the env because the FK does it, not
 *    because a teardown path remembers to. If either FK loses `cascade`, or
 *    the one-holder CHECK goes, a row can outlive its sprite's owner or be
 *    owned by nobody.
 *  - **A relay never points at 8080.** A relay from 8080 to 8080 is a loop.
 *    The other half of the old biconditional — "a non-8080 target always has
 *    a relay" — was deliberately dropped when consent arrived: a detected but
 *    unshared port, and an approved one whose relay is not created yet, are
 *    both legal and both serve nothing (the sprite URL routes to 8080 alone).
 *    Relaxing this remaining half is the documented migration seam for real
 *    httpPort routing, and must be a deliberate edit here.
 *  - **Consent is per PORT, and paired with its time.** `approvedPort` names
 *    the port a person agreed to share, so a dev server that moves is a new
 *    decision rather than an inherited one, and `approvedAt` cannot drift
 *    away from it.
 *  - **NO public-exposure column.** v1 has no public bit — not a disabled one,
 *    none. Adding one is a migration plus a containment ruling. A column whose
 *    name mentions public/expose/visibility appearing here is that decision
 *    being skipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm';
import { devPreviewServices, devPreviewServicesRelations, DEV_PREVIEW_SPRITE_HTTP_PORT } from '../dev-preview-services';
import { agentWorkspaces } from '../agent-workspaces';
import { driveEnvs } from '../drive-envs';
import { schema } from '../../schema';

const config = getTableConfig(devPreviewServices);
const columns = getTableColumns(devPreviewServices);
/** The CHECK's predicate rendered from its chunks (the same technique `drive-envs.test.ts` uses). */
const checkSql = (name: string): string => {
  const check = config.checks.find((entry) => entry.name === name);
  expect(check, `CHECK ${name} exists`).toBeDefined();
  const chunks = (check!.value as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const named = chunk as { name?: unknown; value?: unknown };
      if (typeof named.name === 'string') return named.name;
      if (Array.isArray(named.value)) return named.value.join('');
      return '';
    })
    .join(' ');
};

/** Every migration statement that mentions the table — the artifact the database actually runs. */
const drizzleDir = path.resolve(__dirname, '../../../drizzle');
const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const migrationSql = journal.entries
  .map((entry) => readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), 'utf8'))
  .filter((sql) => sql.includes('dev_preview_services'))
  .join('\n');

describe('dev_preview_services', () => {
  it('is registered in the schema barrel', () => {
    expect(config.name).toBe('dev_preview_services');
    expect(schema.devPreviewServices).toBe(devPreviewServices);
    expect(schema.devPreviewServicesRelations).toBe(devPreviewServicesRelations);
  });

  it('is keyed to the Sprite INSTANCE — NOT NULL and UNIQUE', () => {
    expect(columns.spriteInstanceId.notNull).toBe(true);
    const unique = config.indexes.find((index) => index.config.name === 'dev_preview_services_sprite_instance_idx');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => ('name' in column ? column.name : null))).toEqual(['spriteInstanceId']);
    expect(columns.sandboxId.notNull).toBe(true);
  });

  it('has exactly one holder, and both holder FKs cascade', () => {
    const fks = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        column: ref.columns.map((column) => column.name).join(','),
        table: getTableConfig(ref.foreignTable).name,
        onDelete: fk.onDelete,
      };
    });
    expect(fks).toEqual(
      expect.arrayContaining([
        { column: 'workspaceId', table: getTableConfig(agentWorkspaces).name, onDelete: 'cascade' },
        { column: 'envId', table: getTableConfig(driveEnvs).name, onDelete: 'cascade' },
      ]),
    );
    // Plus the approver attribution FK; the holder FKs are the two that cascade.
    expect(fks).toHaveLength(3);
    expect(columns.workspaceId.notNull).toBe(false);
    expect(columns.envId.notNull).toBe(false);
    // One row per HOLDER, structurally — the upsert's conflict targets. Partial,
    // so the NULL side of each row stays out and the two never interfere.
    for (const [name, column] of [['dev_preview_services_workspace_id_idx', 'workspaceId'], ['dev_preview_services_env_id_idx', 'envId']] as const) {
      const holderIndex = config.indexes.find((index) => index.config.name === name);
      expect(holderIndex?.config.unique, `${name} is UNIQUE`).toBe(true);
      expect(holderIndex?.config.where, `${name} is partial`).toBeDefined();
      expect(holderIndex?.config.columns.map((c) => ('name' in c ? c.name : null))).toEqual([column]);
    }
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "dev_preview_services_workspace_id_idx" ON "dev_preview_services" USING btree ("workspaceId") WHERE "dev_preview_services"."workspaceId" IS NOT NULL');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "dev_preview_services_env_id_idx" ON "dev_preview_services" USING btree ("envId") WHERE "dev_preview_services"."envId" IS NOT NULL');
    const oneHolder = checkSql('dev_preview_services_one_holder_check');
    expect(oneHolder.replace(/\s+/g, ' ')).toContain('workspaceId IS NULL) <> ( envId IS NULL)');
  });

  it('never points a relay at the 8080 slot itself, and the target is a TCP port', () => {
    expect(DEV_PREVIEW_SPRITE_HTTP_PORT).toBe(8080);
    expect(columns.targetPort.notNull).toBe(true);
    expect(columns.relayServiceName.notNull).toBe(false);
    expect(checkSql('dev_preview_services_relay_never_8080_check').replace(/\s+/g, ' ')).toContain('relayServiceName IS NULL OR');
    // The literal 8080 is a `sql.raw` chunk the renderer above cannot see — so
    // the migration text, which is what Postgres enforces, is asserted directly.
    expect(migrationSql).toContain(
      'CONSTRAINT "dev_preview_services_relay_never_8080_check" CHECK ("dev_preview_services"."relayServiceName" IS NULL OR "dev_preview_services"."targetPort" <> 8080)',
    );
    // Every statement in 0288 is guarded, so a second pass is a no-op rather
    // than a failed deployment command.
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "approvedPort"');
    // The biconditional it replaced is GONE from the live schema — a detected
    // but unshared port is a legal row, and re-adding the other half would
    // make consent unrecordable.
    expect(config.checks.map((entry) => entry.name)).not.toContain('dev_preview_services_relay_iff_not_8080_check');
    // `IF EXISTS`, because the migration is written to survive the re-run its
    // own hash change forces — see 0288's header.
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS "dev_preview_services_relay_iff_not_8080_check"');
    expect(checkSql('dev_preview_services_target_port_range_check')).toContain('BETWEEN 1 AND 65535');
  });

  it('records CONSENT per port, paired with its time, and never lets attribution grant it', () => {
    expect(columns.approvedPort.notNull).toBe(false);
    expect(columns.approvedAt.notNull).toBe(false);
    // Paired, so a port can never be approved at no time and vice versa.
    expect(checkSql('dev_preview_services_approved_paired_check').replace(/\s+/g, ' ')).toContain('approvedPort IS NULL) = ( approvedAt IS NULL)');
    expect(checkSql('dev_preview_services_approved_port_range_check')).toContain('BETWEEN 1 AND 65535');
    // Attribution only: nullable, and `set null` so deleting the approver
    // cannot cascade away a live preview — and cannot be read as authority.
    const approver = config.foreignKeys.map((fk) => ({ column: fk.reference().columns.map((c) => c.name).join(','), onDelete: fk.onDelete }))
      .find((fk) => fk.column === 'approvedByUserId');
    expect(approver?.onDelete).toBe('set null');
    expect(columns.approvedByUserId.notNull).toBe(false);
  });

  it('stores stopped-by-user INTENT and detection time, and no status', () => {
    expect(columns.stoppedByUserAt.notNull).toBe(false);
    expect(columns.detectedAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toContain('status');
  });

  it('has NO public-exposure column at all', () => {
    const names = Object.keys(columns).map((name) => name.toLowerCase());
    // `approved*` is consent to SHARE a port with people who already have
    // access, which is not exposure to the public — the banned list is about
    // a column that would make a sandbox reachable without PageSpace's gate.
    for (const banned of ['public', 'expos', 'visib', 'auth']) {
      expect(names.filter((name) => name.includes(banned)), `no column mentioning "${banned}"`).toEqual([]);
    }
    expect(Object.keys(columns).sort()).toEqual(
      ['approvedAt', 'approvedByUserId', 'approvedPort', 'createdAt', 'detectedAt', 'envId', 'id', 'relayServiceName', 'sandboxId', 'selectedByUserAt', 'spriteInstanceId', 'stoppedByUserAt', 'targetPort', 'updatedAt', 'workspaceId'],
    );
  });

  it('has NO reclaim trigger and no reclaim path — a relay dies with its sprite', () => {
    // The teardown outbox is fed by AFTER DELETE triggers on the Sprite HOLDER
    // tables only. Nothing in the migration corpus may wire this table to it:
    // a relay is a process inside the VM, holds nothing and bills nothing on
    // its own (spike §4, §6), so a trigger here would enqueue a kill for a
    // resource that does not exist.
    expect(migrationSql).toContain('CREATE TABLE "dev_preview_services"');
    expect(migrationSql).not.toContain('machine_sprite_reclaims');
    expect(migrationSql.toUpperCase()).not.toContain('CREATE TRIGGER');
  });
});
