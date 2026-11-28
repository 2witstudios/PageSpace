/**
 * The I/O edge of `classifyCallerCredential`: reads an OAuth caller's token
 * issuance (issuing client + principal account type) and classifies it. The
 * lookup runs only when it could matter — an `account`-scoped OAuth token.
 */
import type { AuthResult } from '@/lib/auth';
import { findAccessTokenIssuance } from '@/lib/repositories/oauth-repository';
import { classifyCallerCredential, type CallerCredential } from './caller-credential';

export async function resolveCallerCredential(auth: AuthResult): Promise<CallerCredential> {
  if (auth.tokenType === 'oauth' && auth.scopes.account) {
    const issuance = await findAccessTokenIssuance(auth.tokenId);
    return classifyCallerCredential({ tokenType: auth.tokenType, hasAccountScope: true, issuance });
  }
  return classifyCallerCredential({ tokenType: auth.tokenType, hasAccountScope: false, issuance: null });
}
