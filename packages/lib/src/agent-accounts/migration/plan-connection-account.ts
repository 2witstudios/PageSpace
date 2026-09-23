/**
 * `planConnectionAccount` — what one legacy `integration_connections` row
 * becomes in the credential plane (ADR 0005 §6: migrate each row's material
 * into an `agent_accounts` reference + plane secret). Pure; the backfill
 * adapter hands it the decrypted legacy credentials and the provider's auth
 * method, and puts the result through the plane's ingress.
 *
 * The key is placed on the wire EXACTLY as `applyAuth` placed it for the
 * connection — same header or query name, same prefix — so a migrated tool
 * call is byte-identical upstream. The account is pinned to the provider's
 * canonical origin (a base path is not part of an origin).
 *
 * Refused, never approximated (the row stays on the legacy ratchet):
 * - a drive-scoped row: accounts are user- or agent-page-owned (D-16);
 * - a per-connection base-URL override: the D-28 SSRF input ADR 0005 drops;
 * - OAuth holding a refresh token or an expiry: it needs the refresh worker;
 * - `api_key` in the body, or more than one credential header;
 * - a missing value, a value with a control character or over the plane's
 *   8 KiB limit, or a placement name that is not an HTTP token.
 */
import type { AuthMethod } from '../../integrations/types';
import type { CanonicalOrigin } from '../canonical-request';
import type { SecretMaterialByKind } from '../store/store-adapter';
import { canonicalOriginOf } from '../normalize-origin';

export type ConnectionAccountPlan =
  | {
      readonly ok: true;
      readonly owner: { readonly kind: 'user'; readonly userId: string };
      readonly kind: 'api_key';
      readonly material: SecretMaterialByKind['api_key'];
      readonly allowedOrigins: readonly CanonicalOrigin[];
      readonly providerSlug: string;
    }
  | { readonly ok: false; readonly reason: 'drive_scoped' | 'base_url_override' | 'invalid_origin' | 'no_credential' | 'unsupported_auth' | 'needs_refresh_worker' | 'value_invalid' };

type Refusal = Extract<ConnectionAccountPlan, { readonly ok: false }>;
type Placement = SecretMaterialByKind['api_key'];

/** The plane's wire limit for `put.material.value` (`plane-wire.ts`). */
const MAX_VALUE_LENGTH = 8_192;
const MAX_NAME_LENGTH = 64;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
/** RFC 9110 `token` characters — valid as a header name and as a plain query name. */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const refuse = (reason: Refusal['reason']): Refusal => ({ ok: false, reason });

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value !== '';

function placementFor(authMethod: AuthMethod, credentials: Readonly<Record<string, string>>): Placement | Refusal {
  switch (authMethod.type) {
    case 'none':
      return refuse('no_credential');
    case 'api_key': {
      const { placement, paramName, prefix = '' } = authMethod.config;
      if (placement === 'body') return refuse('unsupported_auth');
      return nonEmpty(credentials.apiKey) ? { value: `${prefix}${credentials.apiKey}`, placement: { in: placement, name: paramName } } : refuse('no_credential');
    }
    case 'bearer_token': {
      const { headerName = 'Authorization', prefix = 'Bearer ' } = authMethod.config;
      return nonEmpty(credentials.token) ? { value: `${prefix}${credentials.token}`, placement: { in: 'header', name: headerName } } : refuse('no_credential');
    }
    case 'basic_auth': {
      const username = credentials[authMethod.config.usernameField];
      const password = credentials[authMethod.config.passwordField];
      if (username === undefined || password === undefined) return refuse('no_credential');
      return { value: `Basic ${btoa(`${username}:${password}`)}`, placement: { in: 'header', name: 'Authorization' } };
    }
    case 'oauth2': {
      const { tokenPlacement = 'header', tokenPrefix = 'Bearer ' } = authMethod.config;
      const accessToken = nonEmpty(credentials.accessToken) ? credentials.accessToken : credentials.access_token;
      if (!nonEmpty(accessToken)) return refuse('no_credential');
      if ([credentials.refreshToken, credentials.refresh_token, credentials.expiresAt, credentials.expires_at].some(nonEmpty)) return refuse('needs_refresh_worker');
      return tokenPlacement === 'query' ? { value: accessToken, placement: { in: 'query', name: 'access_token' } } : { value: `${tokenPrefix}${accessToken}`, placement: { in: 'header', name: 'Authorization' } };
    }
    case 'custom_header': {
      const secretHeaders = authMethod.config.headers.filter((header) => header.valueFrom === 'credential');
      if (secretHeaders.length > 1) return refuse('unsupported_auth');
      const [header] = secretHeaders;
      const value = header?.credentialKey === undefined ? undefined : credentials[header.credentialKey];
      return header !== undefined && nonEmpty(value) ? { value, placement: { in: 'header', name: header.name } } : refuse('no_credential');
    }
  }
}

export function planConnectionAccount({
  connection,
  provider,
  credentials,
}: {
  readonly connection: { readonly userId: string | null; readonly driveId: string | null; readonly baseUrlOverride: string | null };
  readonly provider: { readonly slug: string; readonly baseUrl: string; readonly authMethod: AuthMethod };
  /** The DECRYPTED legacy credentials (the backfill adapter's locals only). */
  readonly credentials: Readonly<Record<string, string>>;
}): ConnectionAccountPlan {
  if (connection.driveId !== null || connection.userId === null) return refuse('drive_scoped');
  if (connection.baseUrlOverride !== null) return refuse('base_url_override');
  let base: URL;
  try {
    base = new URL(provider.baseUrl);
  } catch {
    return refuse('invalid_origin');
  }
  const origin = canonicalOriginOf(base);
  if (!origin.ok) return refuse('invalid_origin');

  const material = placementFor(provider.authMethod, credentials);
  if ('ok' in material) return material;
  if (material.value.length > MAX_VALUE_LENGTH || CONTROL_CHAR_RE.test(material.value)) return refuse('value_invalid');
  if (material.placement.name.length > MAX_NAME_LENGTH || !TOKEN_RE.test(material.placement.name)) return refuse('value_invalid');

  return { ok: true, owner: { kind: 'user', userId: connection.userId }, kind: 'api_key', material, allowedOrigins: [origin.origin], providerSlug: provider.slug };
}
