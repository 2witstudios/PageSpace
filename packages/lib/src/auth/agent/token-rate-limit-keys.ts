/**
 * Rate-limit bucket keys for the `pagespace-agent` token grants — the
 * jwt-bearer exchange and that client's refresh_token grant.
 *
 * Deliberately NOT a per-client bucket: `client_id=pagespace-agent` is shared
 * by every agent on the platform, so a per-client bucket is one global bucket
 * that a single IP can exhaust to lock every agent out. Agents are limited per
 * client IP (AGENT_TOKEN_IP, generous: fleets behind one NAT or CI runner share
 * an IP) and per presented credential (AGENT_TOKEN_CREDENTIAL, tight: a hot
 * loop on one secret). The credential bucket is keyed by the SHA3-256 hash —
 * these keys are persisted in the rate-limit table, so the raw secret never is.
 *
 * @module @pagespace/lib/auth/agent/token-rate-limit-keys
 */

import { hashToken } from '../token-utils';

export function agentTokenIpRateLimitKey(ip: string): string {
  return `agent-token:ip:${ip}`;
}

export function agentTokenCredentialRateLimitKey(credential: string): string {
  return `agent-token:credential:${hashToken(credential)}`;
}
