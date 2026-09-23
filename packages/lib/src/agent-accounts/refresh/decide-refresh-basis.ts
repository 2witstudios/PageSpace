/**
 * `decideRefreshBasis` — whether material the refresh worker resolved may be
 * the basis of a refresh (RFC 9700 §4.14.2). Pure.
 *
 * The store's rotation grace serves the PREVIOUS version to a grant that named
 * it. For an executor that is a few minutes of an older access token; for the
 * refresh worker it is a refresh token the provider has already spent, and
 * presenting it is a replay a reuse-detecting provider answers by revoking the
 * whole family. Found by the real-Infisical crash test (a rotation committed
 * forward after a crash, then a grant still naming the old version). Only the
 * plane's current version is a basis; anything else, or an unattested current
 * version, is `superseded` and nothing is sent.
 */
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';

export function decideRefreshBasis({
  resolvedVersion,
  currentVersion,
}: {
  readonly resolvedVersion: CredentialVersion;
  /** The plane metadata store's committed `currentVersion` for the ref, or null when it could not be read. */
  readonly currentVersion: CredentialVersion | null;
}): { readonly basis: 'current' | 'superseded' } {
  return { basis: currentVersion !== null && resolvedVersion === currentVersion ? 'current' : 'superseded' };
}
