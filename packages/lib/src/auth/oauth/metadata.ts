/**
 * RFC 8414 authorization server metadata — pure construction from injected
 * config. The issuer must come from the deployment's own base-URL config,
 * never a request `Host` header (zero trust: `Host` is attacker-controlled).
 * The Next.js route is a one-line shell around `buildServerMetadata`.
 *
 * @module @pagespace/lib/auth/oauth/metadata
 */

/** RFC 7523 §2.1 — the auth.md `identity_assertion` (our opaque `ps_agent_*` secret) is presented under this URN (ADR 0005 Decision 5). */
export const AGENT_ASSERTION_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** The agent polls its claim with this grant; on approval it receives a fresh token pair for ITSELF (ADR 0005 Decision 7). */
export const AGENT_CLAIM_GRANT_TYPE = 'urn:pagespace:agent-auth:grant-type:claim';

const GRANT_TYPES_SUPPORTED = [
  'authorization_code',
  'refresh_token',
  'urn:ietf:params:oauth:grant-type:device_code',
  AGENT_ASSERTION_GRANT_TYPE,
  AGENT_CLAIM_GRANT_TYPE,
] as const;

/** auth.md: the only identity type we can verify is "none" — no vendor-verifiable agent identity exists. */
const AGENT_IDENTITY_TYPES_SUPPORTED = ['anonymous'] as const;

const RESPONSE_TYPES_SUPPORTED = ['code'] as const;

const CODE_CHALLENGE_METHODS_SUPPORTED = ['S256'] as const;

const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ['none'] as const;

/** ADR 0002 Decision 1 grammar. `drive:*` stands for the templated `drive:<driveId>[:role]` family. */
const SCOPES_SUPPORTED = ['account', 'offline_access', 'manage_keys', 'drive:*'] as const;

export interface OAuthServerConfig {
  /** Canonical deployment origin, e.g. `https://pagespace.ai`. Trailing slash tolerated. */
  issuer: string;
}

/**
 * auth.md agent-registration block (ADR 0005 Decision 12), served inside the
 * RFC 8414 document so a generic auth.md client can discover the agent doors
 * from the same URL it already reads. Every URL is derived from the issuer.
 */
export interface AgentAuthMetadata {
  /** The human/agent-readable recipe: `/auth.md`. */
  skill: string;
  identity_endpoint: string;
  claim_endpoint: string;
  /** PageSpace extension: where to fetch the proof-of-work challenge before registering. */
  challenge_endpoint: string;
  identity_types_supported: readonly string[];
  assertion_grant_type: string;
  claim_grant_type: string;
}

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  grant_types_supported: readonly string[];
  response_types_supported: readonly string[];
  code_challenge_methods_supported: readonly string[];
  token_endpoint_auth_methods_supported: readonly string[];
  scopes_supported: readonly string[];
  agent_auth: AgentAuthMetadata;
}

/**
 * Trims trailing `/` characters without a regex — `/\/+$/` is flagged by
 * static analysis as a polynomial-backtracking risk on attacker-influenced
 * input (CodeQL js/polynomial-redos); this loop is linear in the input
 * length by construction.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

export function buildServerMetadata(config: OAuthServerConfig): OAuthServerMetadata {
  const issuer = trimTrailingSlashes(config.issuer);

  return {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    device_authorization_endpoint: `${issuer}/api/oauth/device_authorization`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    grant_types_supported: GRANT_TYPES_SUPPORTED,
    response_types_supported: RESPONSE_TYPES_SUPPORTED,
    code_challenge_methods_supported: CODE_CHALLENGE_METHODS_SUPPORTED,
    token_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
    scopes_supported: SCOPES_SUPPORTED,
    agent_auth: {
      skill: `${issuer}/auth.md`,
      identity_endpoint: `${issuer}/api/agent/identity`,
      claim_endpoint: `${issuer}/api/agent/claim`,
      challenge_endpoint: `${issuer}/api/agent/challenge`,
      identity_types_supported: AGENT_IDENTITY_TYPES_SUPPORTED,
      assertion_grant_type: AGENT_ASSERTION_GRANT_TYPE,
      claim_grant_type: AGENT_CLAIM_GRANT_TYPE,
    },
  };
}
