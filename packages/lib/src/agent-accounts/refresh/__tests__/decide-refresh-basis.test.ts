/**
 * L3·G3 — `decideRefreshBasis`: whether material the refresh worker resolved
 * may be the basis of a refresh (RFC 9700 §4.14.2).
 *
 * Found by the real-Infisical crash test: after a rotation lands, the store's
 * rotation grace still serves the PREVIOUS version to a grant that named it.
 * For an executor that is a harmless few minutes of an older access token;
 * for the refresh worker it is a refresh token the provider has already
 * spent, and presenting it is a replay that a reuse-detecting provider
 * answers by revoking the whole family. Only the plane's current version may
 * be refreshed from; anything else — or an unknown current version — means
 * another refresh already landed and nothing is sent.
 */
import { describe, expect, it } from 'vitest';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import { decideRefreshBasis } from '../decide-refresh-basis';

const v = (n: number) => n as CredentialVersion;

describe('decideRefreshBasis', () => {
  it('given material at the plane current version, should allow it as the refresh basis', () => {
    const actual = decideRefreshBasis({ resolvedVersion: v(3), currentVersion: v(3) });
    const expected = { basis: 'current' };
    expect(actual).toEqual(expected);
  });

  it('given material from rotation grace (an older version), should refuse — its refresh token is already spent', () => {
    const actual = decideRefreshBasis({ resolvedVersion: v(2), currentVersion: v(3) });
    const expected = { basis: 'superseded' };
    expect(actual).toEqual(expected);
  });

  it('given a current version the plane cannot attest, should refuse rather than risk a replay', () => {
    const actual = [decideRefreshBasis({ resolvedVersion: v(3), currentVersion: null }), decideRefreshBasis({ resolvedVersion: v(4), currentVersion: v(3) })];
    const expected = [{ basis: 'superseded' }, { basis: 'superseded' }];
    expect(actual).toEqual(expected);
  });
});
