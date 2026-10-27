/**
 * `planMigrationStep` — where one connection's credential is read, written,
 * moved or dropped while `integration_connections.credentials` (Λ2: every
 * integration token in the main Postgres under the global `ENCRYPTION_KEY`)
 * moves into the credential plane. Pure; the rollout pattern is the one
 * `docs/security/pii-encryption-design.md` uses for a column:
 *
 *   dual_read  — reads prefer the plane, fall back to legacy; writes stay legacy
 *   write_new  — new credentials go to the plane only
 *   backfill   — the migration script moves each legacy row, then clears it
 *   drop       — the legacy column is never read; droppable once empty
 *
 * Invariants:
 * - A connection with a plane reference reads ONLY from the plane: a legacy
 *   copy beside it is stale by definition (the plane may have rotated). The
 *   same rule sends a new credential for an already-moved connection to the
 *   plane even in dual_read, or the plane would shadow it on read.
 * - Nothing is decrypted from the legacy column in the drop phase.
 * - The backfill clears the legacy copy only after the plane attests a version
 *   at least the one recorded at the move — never on the strength of the
 *   main-DB reference alone; otherwise it would delete the only good copy.
 * - The column is droppable only when no row still holds it.
 */
import type { AccountId, CredentialVersion } from '@pagespace/db/schema/agent-accounts';

export type MigrationPhase = 'dual_read' | 'write_new' | 'backfill' | 'drop';

/** What the caller is doing with this row: a tool/route reading it, an OAuth callback or form storing a new credential, the backfill script, or the drop check. */
export type MigrationOperation = 'read' | 'write' | 'backfill' | 'drop';

export type ConnectionCredentialState = {
  /** `integration_connections.credentials` is non-null. */
  readonly hasLegacyCredentials: boolean;
  /** The plane account this connection's material was moved into, with the version recorded at the move; null = not moved. */
  readonly planeRef: { readonly accountId: AccountId; readonly credentialVersion: CredentialVersion } | null;
  /** The plane's current version for that account (`describe`), or null when the plane did not attest one. Read only by the backfill. */
  readonly planeObservedVersion: CredentialVersion | null;
};

export type MigrationAction =
  | { readonly action: 'read_plane' }
  | { readonly action: 'read_legacy' }
  | { readonly action: 'none' }
  | { readonly action: 'write_legacy' }
  | { readonly action: 'put_to_plane' }
  | { readonly action: 'clear_legacy' }
  | { readonly action: 'drop_ready' }
  | { readonly action: 'refuse'; readonly reason: 'legacy_after_drop' | 'phase_too_early' | 'plane_disagrees' | 'legacy_remaining' };

const PHASE_ORDER: Readonly<Record<MigrationPhase, number>> = { dual_read: 0, write_new: 1, backfill: 2, drop: 3 };

const reached = (phase: MigrationPhase, target: MigrationPhase): boolean => PHASE_ORDER[phase] >= PHASE_ORDER[target];

export function planMigrationStep({
  phase,
  operation,
  row,
}: {
  readonly phase: MigrationPhase;
  readonly operation: MigrationOperation;
  readonly row: ConnectionCredentialState;
}): MigrationAction {
  switch (operation) {
    case 'read':
      if (row.planeRef !== null) return { action: 'read_plane' };
      if (!row.hasLegacyCredentials) return { action: 'none' };
      if (reached(phase, 'drop')) return { action: 'refuse', reason: 'legacy_after_drop' };
      return { action: 'read_legacy' };
    case 'write':
      if (row.planeRef !== null || reached(phase, 'write_new')) return { action: 'put_to_plane' };
      return { action: 'write_legacy' };
    case 'backfill':
      if (!reached(phase, 'backfill')) return { action: 'refuse', reason: 'phase_too_early' };
      if (!row.hasLegacyCredentials) return { action: 'none' };
      if (row.planeRef === null) return { action: 'put_to_plane' };
      if (row.planeObservedVersion === null || row.planeObservedVersion < row.planeRef.credentialVersion) return { action: 'refuse', reason: 'plane_disagrees' };
      return { action: 'clear_legacy' };
    case 'drop':
      if (!reached(phase, 'drop')) return { action: 'refuse', reason: 'phase_too_early' };
      if (row.hasLegacyCredentials) return { action: 'refuse', reason: 'legacy_remaining' };
      return { action: 'drop_ready' };
  }
}
