/**
 * Static first-party OAuth client registry (ADR 0002 Decision 3).
 *
 * First-party clients (the CLI, `client_id: "pagespace-cli"`) are
 * authoritatively defined here, in code — not in the `oauth_clients` DB
 * table, which exists only to accommodate future RFC 7591 dynamic client
 * registration (not shipped this epic). Registry lookup order: static
 * registry first; an unknown `client_id` is rejected (`invalid_client`).
 *
 * @module @pagespace/lib/auth/oauth/clients
 */

export interface RegisteredClient {
  clientId: string;
  name: string;
  type: 'public';
  /** Exact-match redirect URIs; loopback entries wildcard only the port (see {@link validateRedirectUri}). */
  redirectUris: string[];
  allowedGrantTypes: readonly string[];
  firstParty: boolean;
}

export const PAGESPACE_CLI_CLIENT_ID = 'pagespace-cli';

const PAGESPACE_CLI_CLIENT: RegisteredClient = {
  clientId: PAGESPACE_CLI_CLIENT_ID,
  name: 'PageSpace CLI',
  type: 'public',
  redirectUris: ['http://127.0.0.1/callback', 'http://[::1]/callback'],
  allowedGrantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  firstParty: true,
};

const STATIC_CLIENT_REGISTRY = new Map<string, RegisteredClient>([[PAGESPACE_CLI_CLIENT.clientId, PAGESPACE_CLI_CLIENT]]);

/** Static registry lookup. Unknown `client_id` → null (caller fails closed with `invalid_client`). */
export function getRegisteredClient(clientId: string): RegisteredClient | null {
  if (!clientId) return null;
  return STATIC_CLIENT_REGISTRY.get(clientId) ?? null;
}

/** The two loopback literals RFC 8252 §7.3 allows a wildcard port on. `localhost` is deliberately excluded (§8.3). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

/**
 * Exact-match redirect_uri validation (ADR 0002 Decision 3). The port is the
 * only wildcard component, and only for the two loopback literals above —
 * scheme, host, and path must match exactly. A redirect_uri carrying
 * userinfo, a query string, or a fragment is rejected outright, matching the
 * registration-time constraint (nothing registrable ever has one, so nothing
 * presented at authorize time can match one either).
 */
export function validateRedirectUri(client: Pick<RegisteredClient, 'redirectUris'>, redirectUri: string): boolean {
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) return false;

  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }

  if (candidate.username || candidate.password || candidate.search || candidate.hash) return false;
  if (candidate.hostname === 'localhost') return false;

  for (const registered of client.redirectUris) {
    let pattern: URL;
    try {
      pattern = new URL(registered);
    } catch {
      continue;
    }

    if (LOOPBACK_HOSTNAMES.has(pattern.hostname)) {
      if (
        candidate.protocol === pattern.protocol &&
        candidate.hostname === pattern.hostname &&
        candidate.pathname === pattern.pathname
      ) {
        return true;
      }
      continue;
    }

    if (candidate.toString() === pattern.toString()) return true;
  }

  return false;
}
