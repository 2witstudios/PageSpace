/**
 * Shared edges of the agent API door (ADR 0007, Agent Signup Phase 2): whether
 * the door is open on this deployment, the one issuer every URL derives from,
 * and the no-store JSON every door response uses.
 *
 * Decisions live in `@pagespace/lib/auth/agent/*`; this module only reads the
 * environment those pure functions take as input.
 */
import { NextResponse } from 'next/server';
import { isAgentSignupEnabled } from '@pagespace/lib/auth/agent/enabled';
import { getDeploymentMode } from '@pagespace/lib/deployment-mode';

/** ADR 0007 Decision 11: cloud + tenant always; onprem only with `AGENT_SIGNUP_ENABLED=true`. */
export function isAgentDoorOpen(): boolean {
  return isAgentSignupEnabled({ deploymentMode: getDeploymentMode(), envFlag: process.env.AGENT_SIGNUP_ENABLED });
}

/**
 * The deployment's canonical origin — the same source as the RFC 8414 metadata
 * route, never a request `Host` header (threat model T14).
 */
export function agentIssuer(): string {
  return process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
}

/** Every door response carries a credential or a refusal about one: never cache it. */
export function agentNoStoreJson(body: Record<string, unknown>, status: number, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** A closed door (or a subject that is not yours) answers exactly this. */
export function agentNotFound(): NextResponse {
  return agentNoStoreJson({ error: 'not_found' }, 404);
}

/** 429 with the retry hint in both the body and `Retry-After`. */
export function agentRateLimited(retryAfter: number | undefined): NextResponse {
  const seconds = Math.max(0, Math.ceil(retryAfter ?? 0));
  return agentNoStoreJson({ error: 'rate_limited', retryAfter: seconds }, 429, { 'Retry-After': String(seconds) });
}
