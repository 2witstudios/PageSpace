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
 * The refresh_token grant is the exception to "per presented credential": a
 * refresh token rotates on every use, so keying on it gives every refresh a
 * fresh bucket and bounds nothing. Its bucket is the token FAMILY, which
 * survives rotation (`agentRefreshRateLimitKey`).
 *
 * Secret rotation (`POST /api/agent/secret/rotate`) is limited per agent and
 * per actor (`agentSecretRotateRateLimitKey`): a stolen agent token looping
 * rotation exhausts only the agent's own bucket, never the owner's recovery.
 *
 * @module @pagespace/lib/auth/agent/token-rate-limit-keys
 */

import { hashToken } from '../token-utils';

/**
 * The address a per-IP agent-door bucket is keyed on. An IPv4 address (or an
 * IPv4-mapped IPv6 one) is itself; an IPv6 address is its /64, because one
 * host is routinely handed a whole /64 and could otherwise mint a fresh bucket
 * per address. Anything unparseable is returned unchanged (e.g. `unknown`).
 */
export function agentRateLimitAddress(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (!address.includes(':')) return ip;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1]) return mapped[1];

  const halves = address.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return ip;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return ip;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`;
}

export function agentTokenIpRateLimitKey(ip: string): string {
  return `agent-token:ip:${agentRateLimitAddress(ip)}`;
}

export function agentTokenCredentialRateLimitKey(credential: string): string {
  return `agent-token:credential:${hashToken(credential)}`;
}

/**
 * The refresh_token grant's tight bucket: the token family once the presented
 * token resolves to one, else (unknown or junk token) its hash — such a token
 * fails the grant anyway, and the per-IP bucket bounds how many can be tried.
 */
export function agentRefreshRateLimitKey(input: { familyId: string | null; refreshToken: string }): string {
  return input.familyId !== null
    ? `agent-token:refresh-family:${input.familyId}`
    : agentTokenCredentialRateLimitKey(input.refreshToken);
}

export function agentSecretRotateRateLimitKey(input: { agentUserId: string; actor: 'self' | 'owner' }): string {
  return `agent-secret-rotate:${input.actor}:${input.agentUserId}`;
}
