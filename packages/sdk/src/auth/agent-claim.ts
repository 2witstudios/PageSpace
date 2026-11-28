/**
 * `pollAgentClaim` — the auth.md "Fund" poll (ADR 0008 Decisions 3, 7 and the
 * security review addendum). While a human approves the agent's user code on
 * `/claim`, the agent POSTs
 * `grant_type=urn:pagespace:agent-auth:grant-type:claim&client_id=pagespace-agent`
 * to the token endpoint with its OWN access token as `Authorization: Bearer`.
 * Only that token can read the claim: there is no claim token.
 *
 * Answers use the device-flow vocabulary — `authorization_pending`,
 * `slow_down`, `expired_token`, `access_denied` — plus `invalid_grant` (no claim
 * to report, or already reported) and `invalid_token` (401: the access token is
 * not the agent's own usable one — refresh it and poll again). An approval is
 * `{ claimed: true, owner: { id, name } }` and NOTHING else: the claim mints no
 * token; the agent keeps the ones it holds (Decision 7). A token in the body
 * of a misbehaving server is ignored, never surfaced.
 *
 * Every outcome is a value, never a throw, so a polling loop decides without
 * parsing strings. A plain form-encoded POST rather than a registry operation,
 * like `exchangeAgentAssertion`: the token endpoint speaks OAuth, not JSON.
 */
import { AGENT_CLAIM_GRANT_TYPE } from './agent-assertion.js';

export interface AgentClaimOwner {
  readonly id: string;
  readonly name: string | null;
}

export type AgentClaimPollResult =
  | { readonly kind: 'authorization_pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'expired_token' }
  | { readonly kind: 'access_denied' }
  | { readonly kind: 'invalid_grant' }
  | { readonly kind: 'invalid_token' }
  | { readonly kind: 'request_failed'; readonly message: string }
  | { readonly kind: 'claimed'; readonly owner: AgentClaimOwner | null };

export interface PollAgentClaimOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

type KnownError = 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant' | 'invalid_token';
const KNOWN_ERRORS: ReadonlySet<string> = new Set<KnownError>(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant', 'invalid_token']);

function isKnownError(value: string): value is KnownError {
  return KNOWN_ERRORS.has(value);
}

function errorCode(json: unknown): string | null {
  if (json !== null && typeof json === 'object') {
    const error = (json as Record<string, unknown>).error;
    if (typeof error === 'string') return error;
  }
  return null;
}

function ownerOf(json: Record<string, unknown>): AgentClaimOwner | null {
  const owner = json.owner;
  if (owner === null || typeof owner !== 'object') return null;
  const { id, name } = owner as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, name: typeof name === 'string' ? name : null };
}

export async function pollAgentClaim(
  tokenEndpoint: string,
  accessToken: string,
  clientId: string,
  options: PollAgentClaimOptions = {},
): Promise<AgentClaimPollResult> {
  const fetchImpl = options.fetch ?? fetch;
  const body = new URLSearchParams({ grant_type: AGENT_CLAIM_GRANT_TYPE, client_id: clientId });

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${accessToken}` },
      body: body.toString(),
    });
  } catch (error) {
    // Never the request: its headers carry the access token.
    return { kind: 'request_failed', message: `network_error: ${error instanceof Error ? error.message : String(error)}` };
  }

  const json: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const code = errorCode(json);
    if (code !== null && isKnownError(code)) return { kind: code };
    return { kind: 'request_failed', message: code ?? `http_${response.status}` };
  }

  if (json === null || typeof json !== 'object' || (json as Record<string, unknown>).claimed !== true) {
    return { kind: 'request_failed', message: 'invalid_response' };
  }
  return { kind: 'claimed', owner: ownerOf(json as Record<string, unknown>) };
}
