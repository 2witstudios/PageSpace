/**
 * Which bearer credential speaks for an agent on a key-management action
 * (ADR 0007 Decision 6: agents mint mcp_ keys; Decision 14: agents rotate their
 * secret). One rule, shared by `/api/agent/secret/rotate` and
 * `POST /api/auth/mcp-tokens`, so the two doors cannot disagree.
 *
 * A caller is:
 *  - `session` — a session (browser cookie, or the desktop/mobile session
 *    bearer): a full human-or-agent login, as today;
 *  - `agent_grant_token` — an OAuth access token that is `account`-scoped,
 *    minted for the `pagespace-agent` client (i.e. by the agent's own
 *    jwt-bearer grant), and whose principal is an agent. Only this bearer
 *    shape may manage an agent's keys and secret;
 *  - `other_token` — everything else: every human's OAuth token, a token the
 *    agent granted to any other client, a narrow scope, an mcp_ or service
 *    credential. Key management refuses it exactly as before.
 *
 * Pure: the route resolves the token's issuance (client + principal account
 * type) through `findAccessTokenIssuance` and hands it in.
 */
import { PAGESPACE_AGENT_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import type { AuthResult } from '@/lib/auth';
import { findAccessTokenIssuance, type AccessTokenIssuance } from '@/lib/repositories/oauth-repository';

export type CallerCredential = 'session' | 'agent_grant_token' | 'other_token';

export function classifyCallerCredential(input: {
  tokenType: AuthResult['tokenType'];
  hasAccountScope: boolean;
  issuance: AccessTokenIssuance | null;
}): CallerCredential {
  if (input.tokenType === 'session') return 'session';
  if (
    input.tokenType === 'oauth' &&
    input.hasAccountScope &&
    input.issuance !== null &&
    input.issuance.clientId === PAGESPACE_AGENT_CLIENT_ID &&
    input.issuance.accountType === 'agent'
  ) {
    return 'agent_grant_token';
  }
  return 'other_token';
}

/** May this credential mint or rotate key material at all? (Who it may act FOR is each route's own rule.) */
export function mayManageKeysWithCredential(credential: CallerCredential): boolean {
  return credential !== 'other_token';
}

/** The adapter: classify an authenticated caller, reading the token's issuance only when it could matter. */
export async function resolveCallerCredential(auth: AuthResult): Promise<CallerCredential> {
  const issuance = auth.tokenType === 'oauth' && auth.scopes.account
    ? await findAccessTokenIssuance(auth.tokenId)
    : null;
  return classifyCallerCredential({
    tokenType: auth.tokenType,
    hasAccountScope: auth.tokenType === 'oauth' && auth.scopes.account,
    issuance,
  });
}
