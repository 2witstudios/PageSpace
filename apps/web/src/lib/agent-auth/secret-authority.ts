/**
 * Who may rotate an agent's secret (ADR 0007 Decision 14). Pure.
 *
 * The agent itself, or the human who claimed it. A caller naming an id that
 * is not an agent at all (`identity: null`) is refused exactly like a caller
 * who does not own the agent, so the endpoint is no oracle for which ids are
 * agents.
 */
export type AgentSecretActor = 'self' | 'owner';

export function agentSecretActor(input: {
  callerId: string;
  agentUserId: string;
  identity: { ownerUserId: string | null } | null;
}): AgentSecretActor | null {
  if (input.identity === null) return null;
  if (input.callerId === input.agentUserId) return 'self';
  if (input.identity.ownerUserId === input.callerId) return 'owner';
  return null;
}
