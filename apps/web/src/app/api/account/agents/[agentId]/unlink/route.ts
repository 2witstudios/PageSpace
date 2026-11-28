/**
 * POST /api/account/agents/[agentId]/unlink — an owner releases their agent
 * (Agent Signup Phase 4; security review addendum). The agent keeps its
 * identity, drives, keys and tokens; it loses its owner (its AI spend no
 * longer bills them) and, per D-31, `emailVerified`; any claim it has open is
 * denied. The answer carries NOTHING secret: the former owner leaves holding
 * nothing that can start, poll or approve a claim for this agent. If the agent
 * wants an owner again it starts a new claim itself, with its own credential.
 * Session + CSRF; owner only; anyone else and an unknown id are the same 404.
 */
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { isAgentOwner } from '@/lib/agent-auth/agent-owner';
import { unlinkAgent } from '@pagespace/lib/services/agent-ownership';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

interface RouteContext {
  params: Promise<{ agentId: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const { agentId } = await context.params;
  try {
    return await unlink(req, agentId);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(req, { eventType: 'authz.access.denied', resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_unlink_refused', reason: 'store_failed', operation: error.operation } });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function unlink(req: Request, agentId: string) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const limit = await checkDistributedRateLimit(`agent-owner:manage:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.AGENT_OWNER_MANAGE);
  if (!limit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', userId: auth.userId, resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_unlink_rate_limited' } });
    return agentRateLimited(limit.retryAfter);
  }

  const refuse = (reason: string) => {
    auditRequest(req, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_unlink_refused', reason } });
    return agentNotFound();
  };

  if (!(await isAgentOwner(auth, agentId))) return refuse('not_owner');

  const result = await unlinkAgent({ ownerUserId: auth.userId, agentUserId: agentId, now: new Date() });
  if (!result.ok) return refuse('not_owner_at_write');

  auditRequest(req, {
    eventType: 'authz.permission.revoked',
    userId: auth.userId,
    resourceType: 'agent_identity',
    resourceId: agentId,
    details: { agentAuthEvent: 'agent_unlinked' },
  });
  return agentNoStoreJson({ unlinked: true }, 200);
}
