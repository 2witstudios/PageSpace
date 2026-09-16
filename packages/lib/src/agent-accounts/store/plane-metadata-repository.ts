/**
 * The plane's OWN metadata DB (ADR 0005 §2.3, §2.5) — I/O only, no decision
 * logic. Holds the CAS bookkeeping row (`currentVersion`, `previousVersion`,
 * `bindings`, `rotatedAt`, `revokedAt`) that `decideCas`/`decideResolve`
 * consume. Deliberately a SEPARATE Postgres from the main app DB (the ADR's
 * own wording: "plane metadata DB, not the app DB") — `store-adapter-infisical.ts`
 * is the only caller.
 *
 * `withAdvisoryLock` (packages/db) serializes writers per `(tenantId,
 * accountId, kind)` across every replica; this repository never locks or
 * unlocks on its own.
 */
import type { Pool, PoolClient } from 'pg';
import type { AdvisoryLockClient, AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type { PlaneBindings, RevokeReason, SecretRef, StoredSecretFacts } from './store-adapter';

export type PlaneMetadataPool = AdvisoryLockPool & Pick<Pool, 'query'>;

function toAdvisoryLockPool(pool: PlaneMetadataPool): AdvisoryLockPool {
  return {
    connect: async () => {
      const client = (await (pool as unknown as { connect: () => Promise<PoolClient> }).connect()) as unknown as AdvisoryLockClient;
      return client;
    },
  };
}

export type StoredSecretFactsWithCreatedAt = StoredSecretFacts & { readonly createdAt: number };

export type PlaneMetadataRepository = {
  readonly read: (ref: SecretRef) => Promise<StoredSecretFactsWithCreatedAt | null>;
  readonly commit: (input: {
    readonly ref: SecretRef;
    readonly version: number;
    readonly previousVersion: number | null;
    readonly bindings: PlaneBindings;
    readonly rotatedAt: number | null;
  }) => Promise<boolean>;
  /** `false` when no row was marked: the ref is gone, or a revocation is already recorded. */
  readonly markRevoked: (input: { readonly ref: SecretRef; readonly revokedAt: number; readonly reason: RevokeReason }) => Promise<boolean>;
  readonly remove: (ref: SecretRef) => Promise<void>;
  /** CAS on the stored `bindings.policyVersion`; `false` when another writer moved it first. */
  readonly updateBindings: (input: { readonly ref: SecretRef; readonly expectedPolicyVersion: PolicyVersion; readonly bindings: PlaneBindings }) => Promise<boolean>;
};

export function lockKeyFor(ref: SecretRef): string {
  return `agent-accounts:secret:${ref.tenantId}:${ref.accountId}:${ref.kind}`;
}

export function createPlaneMetadataRepository({ pool }: { readonly pool: PlaneMetadataPool }): PlaneMetadataRepository & { readonly advisoryLockPool: AdvisoryLockPool } {
  return {
    advisoryLockPool: toAdvisoryLockPool(pool),

    async read(ref) {
      const result = await pool.query(
        'SELECT current_version, previous_version, bindings, rotated_at, revoked_at, created_at FROM agent_account_secret_versions WHERE tenant_id = $1 AND account_id = $2 AND kind = $3',
        [ref.tenantId, ref.accountId, ref.kind],
      );
      const row = result.rows[0] as
        | { current_version: number; previous_version: number | null; bindings: PlaneBindings; rotated_at: Date | null; revoked_at: Date | null; created_at: Date }
        | undefined;
      if (row === undefined) return null;
      return {
        kind: ref.kind,
        currentVersion: row.current_version as StoredSecretFacts['currentVersion'],
        previousVersion: (row.previous_version ?? null) as StoredSecretFacts['previousVersion'],
        rotatedAt: row.rotated_at?.getTime() ?? null,
        revokedAt: row.revoked_at?.getTime() ?? null,
        bindings: row.bindings,
        createdAt: row.created_at.getTime(),
      };
    },

    // `revoked_at` is written only on INSERT (as NULL) and never by the upsert: revocation is
    // permanent (ADR 0005 §2.2), and `revoke` does not share the writers' advisory lock, so a
    // write that checked "not revoked" before a concurrent revoke must not clear it on commit.
    // The update also requires `revoked_at IS NULL`: a write that passed its revoked check before a
    // lockless revoke landed must not re-open grace fields on the now-revoked row (ADR 0005 F3). A
    // commit that matches no row returns `false`, and the adapter reports it as write_unverified.
    async commit({ ref, version, previousVersion, bindings, rotatedAt }) {
      const result = await pool.query(
        `INSERT INTO agent_account_secret_versions (tenant_id, account_id, kind, current_version, previous_version, bindings, rotated_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         ON CONFLICT (tenant_id, account_id, kind)
         DO UPDATE SET current_version = $4, previous_version = $5, bindings = $6, rotated_at = $7
         WHERE agent_account_secret_versions.revoked_at IS NULL`,
        [ref.tenantId, ref.accountId, ref.kind, version, previousVersion, JSON.stringify(bindings), rotatedAt === null ? null : new Date(rotatedAt)],
      );
      return result.rowCount === 1;
    },

    // Only the FIRST revocation is written: its time is what REVOKE_RETENTION_MS counts from and its
    // reason is what reconciliation and forensics read (a rotation_replay must stay distinguishable
    // from a later admin revoke). A repeat revoke matches no row and changes nothing. It also clears
    // previous_version and rotated_at: no rotation grace survives a revocation (G1a review M7).
    async markRevoked({ ref, revokedAt, reason }) {
      const result = await pool.query(
        'UPDATE agent_account_secret_versions SET revoked_at = $4, revoke_reason = $5, previous_version = NULL, rotated_at = NULL WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND revoked_at IS NULL',
        [ref.tenantId, ref.accountId, ref.kind, new Date(revokedAt), reason],
      );
      return result.rowCount === 1;
    },

    async updateBindings({ ref, expectedPolicyVersion, bindings }) {
      const result = await pool.query(
        "UPDATE agent_account_secret_versions SET bindings = $4 WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND (bindings->>'policyVersion')::integer = $5",
        [ref.tenantId, ref.accountId, ref.kind, JSON.stringify(bindings), expectedPolicyVersion],
      );
      return result.rowCount === 1;
    },

    async remove(ref) {
      await pool.query('DELETE FROM agent_account_secret_versions WHERE tenant_id = $1 AND account_id = $2 AND kind = $3', [ref.tenantId, ref.accountId, ref.kind]);
    },
  };
}
