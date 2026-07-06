/**
 * Human-readable scope summaries for the connected-apps listing page (Phase
 * 8 task k58h61obmc91sn1ndngrsev5). Reuses `describeScopeForConsent` per
 * scope rather than reinventing scope-to-text formatting — this module's
 * only job is looping over an already-parsed grant's scopes and resolving
 * each one's drive/role name from already-fetched lookup maps.
 */
import { describe, it, expect } from 'vitest';
import { describeGrantScopes } from '../grant-scope-summary';

const NO_NAMES = { driveNamesById: new Map(), roleNamesById: new Map() };

describe('describeGrantScopes', () => {
  it('describes an account-scoped grant', () => {
    const descriptions = describeGrantScopes(['account'], NO_NAMES);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatch(/full access/i);
  });

  it('describes offline_access alongside an account scope', () => {
    const descriptions = describeGrantScopes(['account', 'offline_access'], NO_NAMES);
    expect(descriptions).toHaveLength(2);
    expect(descriptions.some((d) => /revoke/i.test(d))).toBe(true);
  });

  it('resolves a drive scope to its drive name', () => {
    const descriptions = describeGrantScopes(['drive:drv123'], {
      driveNamesById: new Map([['drv123', 'Marketing']]),
      roleNamesById: new Map(),
    });
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatch(/Marketing/);
  });

  it('falls back to the raw drive id when no name was resolved', () => {
    const descriptions = describeGrantScopes(['drive:drv123'], NO_NAMES);
    expect(descriptions[0]).toMatch(/drv123/);
  });

  it('resolves a custom-role drive scope to its role name and summary', () => {
    const descriptions = describeGrantScopes(['drive:drv123:role:rol456'], {
      driveNamesById: new Map([['drv123', 'Marketing']]),
      roleNamesById: new Map([['rol456', { name: 'Editor', description: 'Can edit pages' }]]),
    });
    expect(descriptions[0]).toMatch(/Marketing/);
    expect(descriptions[0]).toMatch(/Editor/);
    expect(descriptions[0]).toMatch(/Can edit pages/);
  });

  it('describes multiple drive scopes in the granted order', () => {
    const descriptions = describeGrantScopes(['drive:drv1:admin', 'drive:drv2:member'], {
      driveNamesById: new Map([
        ['drv1', 'Alpha'],
        ['drv2', 'Beta'],
      ]),
      roleNamesById: new Map(),
    });
    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).toMatch(/Alpha/);
    expect(descriptions[0]).toMatch(/admin/i);
    expect(descriptions[1]).toMatch(/Beta/);
  });

  it('returns an empty list for a malformed/unparseable scope string rather than throwing', () => {
    expect(describeGrantScopes(['not a real scope'], NO_NAMES)).toEqual([]);
  });
});
