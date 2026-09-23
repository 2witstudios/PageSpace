/**
 * L3·G3 — `planMigrationStep`: where one connection's credential is read,
 * written, moved or dropped while `integration_connections.credentials` moves
 * into the credential plane (Λ2), staged the way `docs/security/
 * pii-encryption-design.md` rolls out a column: dual-read → write-new →
 * backfill → drop.
 *
 * The invariants the table pins: once a connection has a plane reference the
 * plane is the only source (a legacy copy beside it is stale by definition);
 * nothing is read from the legacy column after the drop phase; the backfill
 * clears a legacy copy only after the plane attests a version at least the
 * one recorded; and the column is droppable only when no row still holds it.
 */
import { describe, expect, it } from 'vitest';
import type { AccountId, CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import { planMigrationStep, type ConnectionCredentialState, type MigrationPhase } from '../plan-migration-step';

const ACCOUNT = 'acct_synthetic' as AccountId;
const v = (n: number) => n as CredentialVersion;

const legacyOnly: ConnectionCredentialState = { hasLegacyCredentials: true, planeRef: null, planeObservedVersion: null };
const moved = (observed: number | null, recorded = 1): ConnectionCredentialState => ({
  hasLegacyCredentials: true,
  planeRef: { accountId: ACCOUNT, credentialVersion: v(recorded) },
  planeObservedVersion: observed === null ? null : v(observed),
});
const planeOnly: ConnectionCredentialState = { hasLegacyCredentials: false, planeRef: { accountId: ACCOUNT, credentialVersion: v(1) }, planeObservedVersion: v(1) };
const noCredential: ConnectionCredentialState = { hasLegacyCredentials: false, planeRef: null, planeObservedVersion: null };

const PHASES: readonly MigrationPhase[] = ['dual_read', 'write_new', 'backfill', 'drop'];

describe('planMigrationStep — read', () => {
  it('given a connection with a plane reference, should read from the plane in every phase even when a legacy copy remains', () => {
    const actual = PHASES.flatMap((phase) => [planMigrationStep({ phase, operation: 'read', row: planeOnly }), planMigrationStep({ phase, operation: 'read', row: moved(1) })]);
    const expected = PHASES.flatMap(() => [{ action: 'read_plane' }, { action: 'read_plane' }]);
    expect(actual).toEqual(expected);
  });

  it('given a connection not yet moved, should read the legacy copy before the drop phase', () => {
    const actual = (['dual_read', 'write_new', 'backfill'] as const).map((phase) => planMigrationStep({ phase, operation: 'read', row: legacyOnly }));
    const expected = [{ action: 'read_legacy' }, { action: 'read_legacy' }, { action: 'read_legacy' }];
    expect(actual).toEqual(expected);
  });

  it('given a connection still holding only a legacy copy in the drop phase, should refuse rather than decrypt it', () => {
    const actual = planMigrationStep({ phase: 'drop', operation: 'read', row: legacyOnly });
    const expected = { action: 'refuse', reason: 'legacy_after_drop' };
    expect(actual).toEqual(expected);
  });

  it('given a connection with no credential anywhere, should read nothing', () => {
    const actual = PHASES.map((phase) => planMigrationStep({ phase, operation: 'read', row: noCredential }));
    const expected = PHASES.map(() => ({ action: 'none' }));
    expect(actual).toEqual(expected);
  });
});

describe('planMigrationStep — write', () => {
  it('given a new credential during dual-read for a connection not yet moved, should still write the legacy column', () => {
    const actual = [planMigrationStep({ phase: 'dual_read', operation: 'write', row: noCredential }), planMigrationStep({ phase: 'dual_read', operation: 'write', row: legacyOnly })];
    const expected = [{ action: 'write_legacy' }, { action: 'write_legacy' }];
    expect(actual).toEqual(expected);
  });

  it('given a new credential from the write-new phase on, should put it into the plane', () => {
    const actual = (['write_new', 'backfill', 'drop'] as const).map((phase) => planMigrationStep({ phase, operation: 'write', row: legacyOnly }));
    const expected = [{ action: 'put_to_plane' }, { action: 'put_to_plane' }, { action: 'put_to_plane' }];
    expect(actual).toEqual(expected);
  });

  it('given a connection already moved, should put a new credential into the plane even during dual-read — a legacy write would be shadowed by the plane on read', () => {
    const actual = planMigrationStep({ phase: 'dual_read', operation: 'write', row: planeOnly });
    const expected = { action: 'put_to_plane' };
    expect(actual).toEqual(expected);
  });
});

describe('planMigrationStep — backfill', () => {
  it('given the rollout before the backfill phase, should refuse to move anything', () => {
    const actual = (['dual_read', 'write_new'] as const).map((phase) => planMigrationStep({ phase, operation: 'backfill', row: legacyOnly }));
    const expected = [
      { action: 'refuse', reason: 'phase_too_early' },
      { action: 'refuse', reason: 'phase_too_early' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a legacy-only connection, should put its material into the plane', () => {
    const actual = [planMigrationStep({ phase: 'backfill', operation: 'backfill', row: legacyOnly }), planMigrationStep({ phase: 'drop', operation: 'backfill', row: legacyOnly })];
    const expected = [{ action: 'put_to_plane' }, { action: 'put_to_plane' }];
    expect(actual).toEqual(expected);
  });

  it('given a moved connection whose plane version is at least the recorded one, should clear the legacy copy', () => {
    const actual = [planMigrationStep({ phase: 'backfill', operation: 'backfill', row: moved(1) }), planMigrationStep({ phase: 'backfill', operation: 'backfill', row: moved(3) })];
    const expected = [{ action: 'clear_legacy' }, { action: 'clear_legacy' }];
    expect(actual).toEqual(expected);
  });

  it('given a moved connection the plane cannot attest, should refuse to clear the only other copy', () => {
    const actual = [planMigrationStep({ phase: 'backfill', operation: 'backfill', row: moved(null) }), planMigrationStep({ phase: 'backfill', operation: 'backfill', row: moved(1, 2) })];
    const expected = [
      { action: 'refuse', reason: 'plane_disagrees' },
      { action: 'refuse', reason: 'plane_disagrees' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a connection with no legacy copy, should do nothing', () => {
    const actual = [planMigrationStep({ phase: 'backfill', operation: 'backfill', row: planeOnly }), planMigrationStep({ phase: 'backfill', operation: 'backfill', row: noCredential })];
    const expected = [{ action: 'none' }, { action: 'none' }];
    expect(actual).toEqual(expected);
  });
});

describe('planMigrationStep — drop', () => {
  it('given the rollout before the drop phase, should refuse to drop', () => {
    const actual = (['dual_read', 'write_new', 'backfill'] as const).map((phase) => planMigrationStep({ phase, operation: 'drop', row: noCredential }));
    const expected = [
      { action: 'refuse', reason: 'phase_too_early' },
      { action: 'refuse', reason: 'phase_too_early' },
      { action: 'refuse', reason: 'phase_too_early' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given any row still holding a legacy copy in the drop phase, should block the drop', () => {
    const actual = [planMigrationStep({ phase: 'drop', operation: 'drop', row: legacyOnly }), planMigrationStep({ phase: 'drop', operation: 'drop', row: moved(1) })];
    const expected = [
      { action: 'refuse', reason: 'legacy_remaining' },
      { action: 'refuse', reason: 'legacy_remaining' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a row with no legacy copy in the drop phase, should allow the drop', () => {
    const actual = [planMigrationStep({ phase: 'drop', operation: 'drop', row: planeOnly }), planMigrationStep({ phase: 'drop', operation: 'drop', row: noCredential })];
    const expected = [{ action: 'drop_ready' }, { action: 'drop_ready' }];
    expect(actual).toEqual(expected);
  });
});
