import { describe, expect, it } from 'vitest';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { SecretRef, StoreAdapter, StoreIdentity, VerifiedGrant } from '../store/store-adapter';

// ADR 0005 §10.22 (G1a review H6) — TYPE-LEVEL. The assertions are the
// `@ts-expect-error` lines, enforced by `tsc` (the lib typecheck), not by
// vitest: an `@ts-expect-error` above a line that compiles is itself an error.
// The function is never called; it exists only to be typechecked.

const resolveCallSites = (
  adapter: StoreAdapter,
  identity: StoreIdentity,
  version: CredentialVersion,
  unnarrowed: VerifiedGrant,
  httpGrant: VerifiedGrant & { readonly aud: 'http-executor' },
  browserGrant: VerifiedGrant & { readonly aud: 'browser-worker' },
  passwordRef: SecretRef & { readonly kind: 'password' },
  oauthRef: SecretRef & { readonly kind: 'oauth2' },
) => [
  // given a grant whose aud is the whole PresenterChannel union, should not compile for password
  // @ts-expect-error — an unnarrowed audience must not widen ResolvableBy to every kind
  adapter.resolve({ ref: passwordRef, version, grant: unnarrowed, identity }),
  // given a grant whose aud is the whole PresenterChannel union, should not compile for oauth2 either
  // @ts-expect-error — an unnarrowed audience must not widen MaterialForChannel to include refreshToken
  adapter.resolve({ ref: oauthRef, version, grant: unnarrowed, identity }),
  // given an http-executor grant, should not compile for password
  // @ts-expect-error — ResolvableBy<'http-executor'> excludes password
  adapter.resolve({ ref: passwordRef, version, grant: httpGrant, identity }),
  // given a browser-worker grant, should compile for password
  adapter.resolve({ ref: passwordRef, version, grant: browserGrant, identity }),
  // given an http-executor grant, should compile for oauth2 and the material should carry no refreshToken
  adapter.resolve({ ref: oauthRef, version, grant: httpGrant, identity }).then((result) =>
    // @ts-expect-error — OAuth2AccessMaterial omits refreshToken
    result.ok ? result.material.refreshToken : null,
  ),
];

describe('StoreAdapter.resolve audience narrowing (ADR 0005 §10.22)', () => {
  it('given the type-level call sites, should be a function checked by tsc and never invoked', () => {
    const actual = typeof resolveCallSites;
    const expected = 'function';
    expect(actual).toEqual(expected);
  });
});
