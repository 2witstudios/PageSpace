/**
 * OAuth Flow Handler
 *
 * Generic OAuth 2.0 handler that works with any provider's OAuth2Config.
 * Handles authorization URL building, code exchange, and token refresh.
 */

import crypto from 'crypto';
import type { OAuth2Config } from '../types';

const OAUTH_TIMEOUT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildAuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier?: string;
  additionalScopes?: string[];
  loginHint?: string;
}

export interface ExchangeCodeParams {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier?: string;
}

export interface RefreshTokenParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHORIZATION URL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an OAuth 2.0 authorization URL.
 */
export function buildOAuthAuthorizationUrl(
  providerConfig: OAuth2Config,
  params: BuildAuthUrlParams
): string {
  const url = new URL(providerConfig.authorizationUrl);

  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);

  // Merge scopes
  const scopes = [...providerConfig.scopes];
  if (params.additionalScopes) {
    for (const scope of params.additionalScopes) {
      if (!scopes.includes(scope)) {
        scopes.push(scope);
      }
    }
  }
  if (scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '));
  }

  // PKCE support
  if (params.codeVerifier) {
    const challenge = generateCodeChallenge(params.codeVerifier);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  // Login hint
  if (params.loginHint) {
    url.searchParams.set('login_hint', params.loginHint);
  }

  return url.toString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN EXCHANGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeOAuthCode(
  providerConfig: OAuth2Config,
  params: ExchangeCodeParams
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });

  if (params.codeVerifier) {
    body.set('code_verifier', params.codeVerifier);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

  try {
    const response = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status})`);
    }

    const data = await response.json();

    if (!data.access_token) {
      throw new Error('Token exchange response missing access_token');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN REFRESH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Refresh an expired access token.
 */
export async function refreshOAuthToken(
  providerConfig: OAuth2Config,
  params: RefreshTokenParams
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

  try {
    const response = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed (${response.status})`);
    }

    const data = await response.json();

    if (!data.access_token) {
      throw new Error('Token refresh response missing access_token');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PKCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a PKCE code verifier and challenge pair.
 */
export function generatePKCE(): PKCEPair {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a PKCE code challenge from a verifier.
 * Uses S256 method: BASE64URL(SHA256(code_verifier))
 */
function generateCodeChallenge(codeVerifier: string): string {
  return crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
}
