/**
 * Is the caller the human who owns this agent? (Settings → Agents, Agent
 * Signup Phase 4.) The rule is the frozen `agentSecretActor` that secret
 * rotation uses — an owner acts on their agent only from a SESSION, never an
 * OAuth token they hold — so revoke, unlink and rotate share one definition.
 * An unknown id, a non-agent and someone else's agent are all `false`.
 */
import type { AuthResult } from '@/lib/auth';
import { getAgentIdentitySummary } from '@pagespace/lib/services/agent-identities';
import { agentSecretActor } from './secret-authority';
import { resolveCallerCredential } from './caller-credential-resolver';

export async function isAgentOwner(auth: AuthResult, agentUserId: string): Promise<boolean> {
  const credential = await resolveCallerCredential(auth);
  const identity = await getAgentIdentitySummary(agentUserId);
  return agentSecretActor({ caller: { id: auth.userId, credential }, agentUserId, identity }) === 'owner';
}
