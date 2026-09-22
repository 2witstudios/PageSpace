/**
 * The plane's OWN metadata DB (ADR 0005 §2.3, §2.5) — I/O only, no decision
 * logic. Two rows per ref (`infisical-dev/plane-metadata.sql` owns the DDL):
 *   - `agent_account_secret_versions`: the CAS bookkeeping and the
 *     PLANE-ATTESTED rotation/revocation facts (`currentVersion`,
 *     `previousVersion`, `rotatedAt`, `revokedAt`) plus the uncertain-write
 *     marker (`pending_*`, G1c E1). These never live in the main DB (G1c R3);
 *   - `agent_account_plane_bindings`: the bindings, the scope they digest and
 *     the pinned consenters (G1c R2, R4) — rewritten only by `updateBindings`
 *     (rebind), CAS on `policy_version`, never by a secret write.
 * Deliberately a SEPARATE Postgres from the main app DB — `store-adapter-infisical.ts`
 * is the only caller. Every multi-row write is ONE statement, so it is atomic
 * without a transaction.
 *
 * `withAdvisoryLock` (packages/db) serializes writers per `(tenantId,
 * accountId, kind)` across every replica; this repository never locks or
 * unlocks on its own.
 */
import type { Pool, PoolClient } from 'pg';
import type { AdvisoryLockClient, AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { CredentialVersion, PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type {
  PendingWrite,
  PlaneBindings,
  PlaneBindingsRecord,
  PlaneConsenters,
  PlaneScope,
  RevokeReason,
  SecretRef,
  StoredSecretFacts,
  WriteDigest,
} from './store-adapter';

export type PlaneMetadataPool = AdvisoryLockPool & Pick<Pool, 'query'>;

function toAdvisoryLockPool(pool: PlaneMetadataPool): AdvisoryLockPool {
  return {
    connect: async () => {
      const client = (await (pool as unknown as { connect: () => Promise<PoolClient> }).connect()) as unknown as AdvisoryLockClient;
      return client;
    },
  };
}

/** Everything the plane holds about a ref: the version facts, the bindings record and when it was created. */
export type StoredPlaneFacts = StoredSecretFacts & {
  readonly createdAt: number;
  readonly scope: PlaneScope;
  readonly consenters: PlaneConsenters;
};

export type PlaneMetadataRepository = {
  readonly read: (ref: SecretRef) => Promise<StoredPlaneFacts | null>;
  /**
   * Commit a verified write. A first write inserts the version row AND pins the bindings record; a
   * later one advances the version row and clears any pending write. `false` when no version row was
   * written — a revocation is recorded on the ref.
   */
  readonly commit: (input: {
    readonly ref: SecretRef;
    readonly version: number;
    readonly previousVersion: number | null;
    readonly rotatedAt: number | null;
    readonly record: PlaneBindingsRecord;
  }) => Promise<boolean>;
  /** Record the uncertain-write marker before a replacing write. `false` when the ref is revoked or already pending. */
  readonly markPending: (input: { readonly ref: SecretRef; readonly pending: PendingWrite }) => Promise<boolean>;
  /**
   * Drop exactly this pending write without moving any version (G2 ruling E1): the write provably did
   * not land. `false` when that pending write is not the one recorded.
   */
  readonly abortPending: (input: { readonly ref: SecretRef; readonly pending: PendingWrite }) => Promise<boolean>;
  /** Advance to exactly the pending write (and open grace if it was a rotation). `false` when that pending write is not recorded. */
  readonly commitForward: (input: { readonly ref: SecretRef; readonly pending: PendingWrite; readonly rotatedAt: number }) => Promise<boolean>;
  /** `false` when no row was marked: the ref is gone, or a revocation is already recorded. */
  readonly markRevoked: (input: { readonly ref: SecretRef; readonly revokedAt: number; readonly reason: RevokeReason }) => Promise<boolean>;
  readonly remove: (ref: SecretRef) => Promise<void>;
  /** CAS on the stored `policy_version`; `false` when another writer moved it first. */
  readonly updateBindings: (input: { readonly ref: SecretRef; readonly expectedPolicyVersion: PolicyVersion; readonly record: PlaneBindingsRecord }) => Promise<boolean>;
};

export function lockKeyFor(ref: SecretRef): string {
  return `agent-accounts:secret:${ref.tenantId}:${ref.accountId}:${ref.kind}`;
}

type Row = {
  current_version: number;
  previous_version: number | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  pending_version: number | null;
  pending_digest: string | null;
  pending_rotation: boolean | null;
  created_at: Date;
  bindings: PlaneBindings | null;
  scope: PlaneScope | null;
  consenters: PlaneConsenters | null;
};

export function createPlaneMetadataRepository({ pool }: { readonly pool: PlaneMetadataPool }): PlaneMetadataRepository & { readonly advisoryLockPool: AdvisoryLockPool } {
  const key = (ref: SecretRef) => [ref.tenantId, ref.accountId, ref.kind];

  return {
    advisoryLockPool: toAdvisoryLockPool(pool),

    async read(ref) {
      const result = await pool.query(
        `SELECT s.current_version, s.previous_version, s.rotated_at, s.revoked_at, s.pending_version, s.pending_digest, s.pending_rotation, s.created_at,
                b.bindings, b.scope, b.consenters
           FROM agent_account_secret_versions s
           LEFT JOIN agent_account_plane_bindings b USING (tenant_id, account_id, kind)
          WHERE s.tenant_id = $1 AND s.account_id = $2 AND s.kind = $3`,
        key(ref),
      );
      const row = result.rows[0] as Row | undefined;
      if (row === undefined) return null;
      // A version row without its bindings row is a plane that lost half a record: never read it as
      // "no bindings" — the adapter turns a throw into store_unavailable.
      if (row.bindings === null || row.scope === null || row.consenters === null) throw new Error('plane metadata: version row without its bindings row');
      const pendingWrite: PendingWrite | null =
        row.pending_version === null || row.pending_digest === null
          ? null
          : { version: row.pending_version as CredentialVersion, digest: row.pending_digest as WriteDigest, rotation: row.pending_rotation === true };
      return {
        kind: ref.kind,
        currentVersion: row.current_version as CredentialVersion,
        previousVersion: (row.previous_version ?? null) as CredentialVersion | null,
        rotatedAt: row.rotated_at?.getTime() ?? null,
        revokedAt: row.revoked_at?.getTime() ?? null,
        bindings: row.bindings,
        pendingWrite,
        createdAt: row.created_at.getTime(),
        scope: row.scope,
        consenters: row.consenters,
      };
    },

    // `revoked_at` is written only on INSERT (as NULL) and never by the upsert: revocation is
    // permanent (ADR 0005 §2.2), and `revoke` does not share the writers' advisory lock, so a
    // write that checked "not revoked" before a concurrent revoke must not clear it on commit.
    // The update also requires `revoked_at IS NULL`: a write that passed its revoked check before a
    // lockless revoke landed must not re-open grace fields on the now-revoked row (ADR 0005 F3). A
    // commit that matches no row returns `false`, and the adapter reports it as write_unverified.
    // The bindings row is inserted with the first version row and never touched by a later commit.
    async commit({ ref, version, previousVersion, rotatedAt, record }) {
      const result = await pool.query(
        `WITH secret AS (
           INSERT INTO agent_account_secret_versions (tenant_id, account_id, kind, current_version, previous_version, rotated_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, NULL)
           ON CONFLICT (tenant_id, account_id, kind)
           DO UPDATE SET current_version = $4, previous_version = $5, rotated_at = $6, pending_version = NULL, pending_digest = NULL, pending_rotation = NULL
           WHERE agent_account_secret_versions.revoked_at IS NULL
           RETURNING 1
         ), bound AS (
           INSERT INTO agent_account_plane_bindings (tenant_id, account_id, kind, bindings, scope, consenters, policy_version)
           SELECT $1, $2, $3, $7, $8, $9, $10 WHERE EXISTS (SELECT 1 FROM secret)
           ON CONFLICT (tenant_id, account_id, kind) DO NOTHING
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM secret)::int AS committed`,
        [
          ...key(ref),
          version,
          previousVersion,
          rotatedAt === null ? null : new Date(rotatedAt),
          JSON.stringify(record.bindings),
          JSON.stringify(record.scope),
          JSON.stringify(record.consenters),
          record.bindings.policyVersion,
        ],
      );
      return (result.rows[0] as { committed: number } | undefined)?.committed === 1;
    },

    async markPending({ ref, pending }) {
      const result = await pool.query(
        `UPDATE agent_account_secret_versions SET pending_version = $4, pending_digest = $5, pending_rotation = $6
          WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND revoked_at IS NULL AND pending_version IS NULL`,
        [...key(ref), pending.version, pending.digest, pending.rotation],
      );
      return result.rowCount === 1;
    },

    // Matches the exact marker (version AND digest), so an abort can never clear a DIFFERENT pending
    // write another replica recorded after this one's section ended.
    async abortPending({ ref, pending }) {
      const result = await pool.query(
        `UPDATE agent_account_secret_versions SET pending_version = NULL, pending_digest = NULL, pending_rotation = NULL
          WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND pending_version = $4 AND pending_digest = $5`,
        [...key(ref), pending.version, pending.digest],
      );
      return result.rowCount === 1;
    },

    // SET expressions read the row's OLD values, so `previous_version = current_version` is the
    // version being replaced. Only a pending rotation opens grace, as only rotate snapshots the
    // companion secret.
    async commitForward({ ref, pending, rotatedAt }) {
      const result = await pool.query(
        `UPDATE agent_account_secret_versions
            SET previous_version = CASE WHEN pending_rotation THEN current_version ELSE NULL END,
                rotated_at = CASE WHEN pending_rotation THEN $6::timestamptz ELSE NULL END,
                current_version = pending_version,
                pending_version = NULL, pending_digest = NULL, pending_rotation = NULL
          WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND revoked_at IS NULL AND pending_version = $4 AND pending_digest = $5`,
        [...key(ref), pending.version, pending.digest, new Date(rotatedAt)],
      );
      return result.rowCount === 1;
    },

    // Only the FIRST revocation is written: its time is what REVOKE_RETENTION_MS counts from and its
    // reason is what reconciliation and forensics read (a rotation_replay must stay distinguishable
    // from a later admin revoke). A repeat revoke matches no row and changes nothing. It also clears
    // previous_version and rotated_at: no rotation grace survives a revocation (G1a review M7). And it
    // clears a pending write: a revoked ref is never served or written again, so there is nothing left
    // to reconcile, and describe must still report the revocation (G1c E1).
    async markRevoked({ ref, revokedAt, reason }) {
      const result = await pool.query(
        'UPDATE agent_account_secret_versions SET revoked_at = $4, revoke_reason = $5, previous_version = NULL, rotated_at = NULL, pending_version = NULL, pending_digest = NULL, pending_rotation = NULL WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND revoked_at IS NULL',
        [...key(ref), new Date(revokedAt), reason],
      );
      return result.rowCount === 1;
    },

    async updateBindings({ ref, expectedPolicyVersion, record }) {
      const result = await pool.query(
        `UPDATE agent_account_plane_bindings SET bindings = $4, scope = $5, consenters = $6, policy_version = $7
          WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 AND policy_version = $8`,
        [...key(ref), JSON.stringify(record.bindings), JSON.stringify(record.scope), JSON.stringify(record.consenters), record.bindings.policyVersion, expectedPolicyVersion],
      );
      return result.rowCount === 1;
    },

    async remove(ref) {
      await pool.query(
        `WITH gone AS (DELETE FROM agent_account_secret_versions WHERE tenant_id = $1 AND account_id = $2 AND kind = $3 RETURNING 1)
         DELETE FROM agent_account_plane_bindings WHERE tenant_id = $1 AND account_id = $2 AND kind = $3`,
        key(ref),
      );
    },
  };
}
