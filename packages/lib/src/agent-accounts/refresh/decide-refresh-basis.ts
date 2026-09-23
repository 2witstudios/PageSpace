import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';

export function decideRefreshBasis(_input: { readonly resolvedVersion: CredentialVersion; readonly currentVersion: CredentialVersion | null }): { readonly basis: 'current' | 'superseded' } {
  throw new Error('decideRefreshBasis: not implemented (RED)');
}
