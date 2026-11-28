/**
 * POST /api/account/agents/[agentId]/revoke — an owner revokes their agent
 * (Agent Signup Phase 4; ADR 0008 Decision 14, §5 assertion 23). `revokeAgent`
 * sets `revokedAt`, bumps `tokenVersion` and revokes every live `mcp_` key in
 * one transaction, so the secret stops signing in AND every session, `ps_at_`,
 * `ps_rt_` and key dies — a control that reaches where the effect lives. The
 * agent's spend no longer reaches its owner (a revoked identity has no billing
 * owner). Session + CSRF; owner only (the rotate rule); anyone else, an
 * unknown id and an already revoked agent are the same 404.
 */
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { isAgentOwner } from '@/lib/agent-auth/agent-owner';
import { AgentIdentityStoreError, revokeAgent } from '@pagespace/lib/services/agent-identities';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

interface RouteContext {
  params: Promise<{ agentId: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  const { agentId } = await context.params;
  try {
    return await revoke(req, agentId);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(req, { eventType: 'authz.access.denied', resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_revoke_refused', reason: 'store_failed', operation: error.operation } });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function revoke(req: Request, agentId: string) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const limit = await checkDistributedRateLimit(`agent-owner:manage:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.AGENT_OWNER_MANAGE);
  if (!limit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', userId: auth.userId, resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_revoke_rate_limited' } });
    return agentRateLimited(limit.retryAfter);
  }

  const refuse = (reason: string) => {
    auditRequest(req, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_identity', resourceId: agentId, details: { agentAuthEvent: 'agent_revoke_refused', reason } });
    return agentNotFound();
  };

  if (!(await isAgentOwner(auth, agentId))) return refuse('not_owner');

  const result = await revokeAgent({ userId: agentId, now: new Date() });
  if (!result.revoked) return refuse('already_revoked');

  auditRequest(req, {
    eventType: 'auth.agent.revoked',
    userId: auth.userId,
    resourceType: 'agent_identity',
    resourceId: agentId,
    details: { agentAuthEvent: 'agent_revoked', actor: 'owner' },
  });
  return agentNoStoreJson({ revoked: true }, 200);
}
