/**
 * GET /api/account/agents — Settings → Agents (Agent Signup Phase 4; ADR 0008
 * Decision 8): the AI agents the signed-in human has claimed and pays for,
 * with name, self-reported source and last activity. Session only, rate
 * limited per user, door-gated (a deployment with agent signup closed has no
 * agents to manage).
 */
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { listOwnedAgents } from '@pagespace/lib/services/agent-ownership';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

export async function GET(req: Request) {
  try {
    return await list(req);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function list(req: Request) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: false });
  if (isAuthError(auth)) return auth.error;

  const limit = await checkDistributedRateLimit(`agent-owner:list:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.AGENT_OWNER_MANAGE);
  if (!limit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', userId: auth.userId, resourceType: 'agent_identity', details: { agentAuthEvent: 'owned_agents_rate_limited' } });
    return agentRateLimited(limit.retryAfter);
  }

  const agents = await listOwnedAgents(auth.userId);
  auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'agent_identity', details: { agentAuthEvent: 'owned_agents_listed', count: agents.length } });

  return NextResponse.json({
    agents: agents.map((agent) => ({
      id: agent.agentUserId,
      name: agent.name,
      source: agent.source,
      createdAt: agent.createdAt.toISOString(),
      claimedAt: agent.claimedAt?.toISOString() ?? null,
      lastActiveAt: agent.lastActiveAt?.toISOString() ?? null,
      revokedAt: agent.revokedAt?.toISOString() ?? null,
    })),
  });
}
