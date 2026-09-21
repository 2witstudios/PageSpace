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
 *  - the AGENT ITSELF may use a session or the access token its own
 *    jwt-bearer grant issued: `account`-scoped AND minted for the
 *    `pagespace-agent` client. An account token the agent granted to any
 *    other client (a CLI, a future third-party app), or a narrow token, is
 *    refused — that client must not be able to lock the agent out of itself.
 *
 * A caller naming an id that is not an agent (`identity: null`) is refused
 * exactly like one who does not own the agent, so the endpoint is no oracle
 * for which ids are agents or who owns them.
 */
export type AgentSecretActor = 'self' | 'owner';

/**
 * How the caller authenticated: a browser session; the account-scoped access
 * token minted by the agent's own jwt-bearer grant; or any other token.
 */
export type AgentSecretCallerCredential = 'session' | 'agent_grant_token' | 'other_token';

export function agentSecretActor(input: {
  caller: { id: string; credential: AgentSecretCallerCredential };
  agentUserId: string;
  identity: { ownerUserId: string | null } | null;
}): AgentSecretActor | null {
  const { caller, identity } = input;
  if (identity === null) return null;
  if (caller.id === input.agentUserId) return caller.credential === 'other_token' ? null : 'self';
  if (identity.ownerUserId === caller.id && caller.credential === 'session') return 'owner';
  return null;
}
