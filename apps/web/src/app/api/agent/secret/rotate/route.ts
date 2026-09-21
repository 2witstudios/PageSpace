/**
 * POST /api/agent/secret/rotate — replace an agent's `ps_agent_*` secret (ADR
 * 0007 Decision 14; auth.md "Rotate / Revoke").
 *
 * Caller: the agent itself (a session, or the `account`-scoped
 * `ps_at_` its own jwt-bearer grant minted — CSRF is enforced for sessions only) or the human who claimed it,
 * from a SESSION only, naming the agent with `agentId` (see
 * `agentSecretActor` for why an owner's OAuth token is never enough). Anyone else, a non-agent, or a revoked agent answers the same
 * 404. The old secret stops matching immediately; `revokeExistingTokens` also
 * bumps `users.tokenVersion` so every live session and token dies. The new
 * secret is returned once, never logged or audited (threat model §3).
 */
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound } from '@/lib/agent-auth/door';
import { agentSecretActor, type AgentSecretCallerCredential } from '@/lib/agent-auth/secret-authority';
import { findAccessTokenClientId } from '@/lib/repositories/oauth-repository';
import { PAGESPACE_AGENT_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAgentIdentitySummary, rotateAgentSecret } from '@pagespace/lib/services/agent-identities';

const AUTH_OPTIONS = { allow: ['session', 'oauth'] as const, requireCSRF: true };

const rotateRequestSchema = z.object({
  agentId: z.string().min(1).max(64).optional(),
  revokeExistingTokens: z.boolean().optional(),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_identity', details: { reason: 'auth_failed', agentAuthEvent: 'secret_rotate_refused' }, riskScore: 0.5 });
    return auth.error;
  }

  const text = await request.text().catch(() => '');
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }
  const parsed = rotateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_identity', details: { reason: 'invalid_request', agentAuthEvent: 'secret_rotate_refused' }, riskScore: 0.2 });
    return agentNoStoreJson({ error: 'invalid_request' }, 400);
  }

  const agentUserId = parsed.data.agentId ?? auth.userId;
  const revokeTokens = parsed.data.revokeExistingTokens ?? false;
  const credential: AgentSecretCallerCredential = auth.tokenType === 'session'
    ? 'session'
    : auth.tokenType === 'oauth' && auth.scopes.account && (await findAccessTokenClientId(auth.tokenId)) === PAGESPACE_AGENT_CLIENT_ID
      ? 'agent_grant_token'
      : 'other_token';
  const actor = agentSecretActor({ caller: { id: auth.userId, credential }, agentUserId, identity: await getAgentIdentitySummary(agentUserId) });
  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_identity', resourceId: agentUserId, details: { reason, agentAuthEvent: 'secret_rotate_refused' }, riskScore: 0.5 });
    return agentNotFound();
  };
  if (actor === null) return refuse('not_agent_or_not_owner');

  const rotated = await rotateAgentSecret({ userId: agentUserId, revokeTokens });
  if (!rotated.ok) return refuse('agent_revoked');

  auditRequest(request, {
    eventType: 'auth.token.updated',
    userId: auth.userId,
    resourceType: 'agent_identity',
    resourceId: agentUserId,
    details: { agentAuthEvent: 'secret_rotated', actor, revokeExistingTokens: revokeTokens, secretVersion: rotated.data.secretVersion },
  });

  return agentNoStoreJson({
    identity_assertion: rotated.data.secret,
    agent_id: agentUserId,
    secret_version: rotated.data.secretVersion,
    revoked_existing_tokens: revokeTokens,
  }, 200);
}
