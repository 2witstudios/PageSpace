import type { AccountId, CredentialVersion } from '@pagespace/db/schema/agent-accounts';

export type MigrationPhase = 'dual_read' | 'write_new' | 'backfill' | 'drop';

export type MigrationOperation = 'read' | 'write' | 'backfill' | 'drop';

export type ConnectionCredentialState = {
  readonly hasLegacyCredentials: boolean;
  readonly planeRef: { readonly accountId: AccountId; readonly credentialVersion: CredentialVersion } | null;
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

export function planMigrationStep(_input: {
  readonly phase: MigrationPhase;
  readonly operation: MigrationOperation;
  readonly row: ConnectionCredentialState;
}): MigrationAction {
  throw new Error('planMigrationStep: not implemented (RED)');
}
