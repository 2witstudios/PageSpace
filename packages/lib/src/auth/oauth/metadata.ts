/**
 * RFC 8414 authorization server metadata — pure construction from injected
 * config. The issuer must come from the deployment's own base-URL config,
 * never a request `Host` header (zero trust: `Host` is attacker-controlled).
 * The Next.js route is a one-line shell around `buildServerMetadata`.
 *
 * @module @pagespace/lib/auth/oauth/metadata
 */

const GRANT_TYPES_SUPPORTED = [
  'authorization_code',
  'refresh_token',
  'urn:ietf:params:oauth:grant-type:device_code',
] as const;

const RESPONSE_TYPES_SUPPORTED = ['code'] as const;

const CODE_CHALLENGE_METHODS_SUPPORTED = ['S256'] as const;

const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ['none'] as const;

/** ADR 0002 Decision 1 grammar. `drive:*` stands for the templated `drive:<driveId>[:role]` family. */
const SCOPES_SUPPORTED = ['account', 'offline_access', 'drive:*'] as const;

export interface OAuthServerConfig {
  /** Canonical deployment origin, e.g. `https://pagespace.ai`. Trailing slash tolerated. */
  issuer: string;
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
}

export function buildServerMetadata(config: OAuthServerConfig): OAuthServerMetadata {
  const issuer = config.issuer.replace(/\/+$/, '');

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
  };
}
