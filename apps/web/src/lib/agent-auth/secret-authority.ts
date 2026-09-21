/**
 * Who may rotate an agent's secret, and over which credential (ADR 0007
 * Decision 14). Pure.
 *
 * Rotation is a key-management action: whoever holds the new secret IS the
 * agent. So:
 *  - the OWNER may rotate only from a browser session. An OAuth access token
 *    an owner holds may be a narrowly scoped grant to some other client; the
 *    `account` scope names account access, not "may take over my agents", so
 *    no OAuth token of the owner's is accepted here;
 *  - the AGENT ITSELF may use a session or its own access token, but only one
 *    carrying the `account` scope — what the jwt-bearer grant issues. A
 *    drive-scoped or otherwise narrow token is refused.
 *
 * A caller naming an id that is not an agent (`identity: null`) is refused
 * exactly like one who does not own the agent, so the endpoint is no oracle
 * for which ids are agents or who owns them.
 */
export type AgentSecretActor = 'self' | 'owner';

/** How the caller authenticated: a browser session, or an OAuth access token with / without `account`. */
export type AgentSecretCallerCredential = 'session' | 'oauth_account' | 'oauth_narrow';

export function agentSecretActor(input: {
  caller: { id: string; credential: AgentSecretCallerCredential };
  agentUserId: string;
  identity: { ownerUserId: string | null } | null;
}): AgentSecretActor | null {
  const { caller, identity } = input;
  if (identity === null) return null;
  if (caller.id === input.agentUserId) return caller.credential === 'oauth_narrow' ? null : 'self';
  if (identity.ownerUserId === caller.id && caller.credential === 'session') return 'owner';
  return null;
}
