/**
 * ADR 0005 §10.22 (G1a review H6) — `tsc` over this file IS the assertion. Every
 * `@ts-expect-error` below must still be an error: if `NarrowedAudience` is removed from
 * `StoreAdapter['resolve']`, the unnarrowed calls compile and tsc reports TS2578 (unused
 * directive) here. The functions are never called; vitest only proves the file loads.
 */
import { describe, expect, it } from 'vitest';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { PresenterChannel } from '../../grant';
import type { RebindInput, SecretRef, StoreAdapter, StoreIdentity, VerifiedGrant } from '../store-adapter';

type Declared = {
  readonly adapter: StoreAdapter;
  readonly identity: StoreIdentity;
  readonly version: CredentialVersion;
  readonly passwordRef: SecretRef & { readonly kind: 'password' };
  readonly oauth2Ref: SecretRef & { readonly kind: 'oauth2' };
  readonly unnarrowed: VerifiedGrant<PresenterChannel>;
  readonly browser: VerifiedGrant<'browser-worker'>;
  readonly http: VerifiedGrant<'http-executor'>;
};

export async function unnarrowedGrantCannotResolve({ adapter, identity, version, passwordRef, oauth2Ref, unnarrowed }: Declared) {
  // @ts-expect-error — an unnarrowed audience must not resolve password
  await adapter.resolve({ ref: passwordRef, version, grant: unnarrowed, identity });
  // @ts-expect-error — an unnarrowed audience must not resolve oauth2 (its material type would include refreshToken)
  await adapter.resolve({ ref: oauth2Ref, version, grant: unnarrowed, identity });
}

export async function narrowedGrantsResolveOnlyTheirKinds({ adapter, identity, version, passwordRef, oauth2Ref, browser, http }: Declared) {
  await adapter.resolve({ ref: passwordRef, version, grant: browser, identity });
  // @ts-expect-error — http-executor never resolves password
  await adapter.resolve({ ref: passwordRef, version, grant: http, identity });
  const oauth2 = await adapter.resolve({ ref: oauth2Ref, version, grant: http, identity });
  if (oauth2.ok) {
    // @ts-expect-error — http-executor oauth2 material has no refreshToken
    void oauth2.material.refreshToken;
  }
}

export async function rebindNeedsAManageIdentity({ adapter, identity }: Declared, input: RebindInput) {
  await adapter.rebind(input);
  // @ts-expect-error — a StoreIdentity without audience 'manage' cannot rebind
  await adapter.rebind({ ...input, identity });
}

describe('store-adapter types (ADR 0005 §10.22)', () => {
  it('given this file, should load — tsc over it is the type-level assertion', () => {
    const actual = [typeof unnarrowedGrantCannotResolve, typeof narrowedGrantsResolveOnlyTheirKinds, typeof rebindNeedsAManageIdentity];
    const expected = ['function', 'function', 'function'];
    expect(actual).toEqual(expected);
  });
});
