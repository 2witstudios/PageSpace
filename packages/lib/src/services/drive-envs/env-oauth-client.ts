/**
 * The platform-managed OAuth client of an ENVIRONMENT (ADR 0004 Decision 12;
 * [D-9] "PageSpace creates and maintains it", [D-10] the callback path).
 *
 * An app built inside a drive environment gets "Sign in with PageSpace" with
 * no registration, no configuration and no secret: this module derives the
 * `oauth_clients` row that makes the env a client, and the two PUBLIC values
 * (`PAGESPACE_URL`, `PAGESPACE_CLIENT_ID`) the sandbox and the published
 * machine are handed so `PageSpaceClient.fromEnvironment()` works unchanged in
 * preview and after publish (US6, US7).
 *
 * **Pure.** No database, no `process.env`, no clock: the env, its drive owner,
 * the preview apex and the published hosting facts are INJECTED, so the row an
 * environment gets is a plain function of those facts — which is what makes
 * the lifecycle upsert idempotent by construction (same inputs, same row).
 *
 * **Held to the third-party bar, by the third party's own validators.** Every
 * redirect emitted here passes `validateRedirectUri` as a NON-first-party
 * client, and the whole row passes `validateClientRegistration` — asserted in
 * the test file rather than restated here, so the two can never drift. The
 * client is `verified` (a human did not review it; the PLATFORM provisioned
 * it, and its redirects are the platform's own hosts), never first-party (a
 * SQL row cannot be — `registeredClientFromRecord` forces `firstParty: false`),
 * and capped at the third-party scope shapes: `profile`, `offline_access` and
 * the four `drive` shapes. `account`, `manage_keys`, `all_drives` and the key
 * operations are unreachable through it, whatever an app asks for.
 *
 * **Public values only.** A `client_id` authenticates nothing (Decision 1:
 * public clients + PKCE), which is the whole reason it may enter a sandbox
 * under `sandbox-env.ts`'s no-secrets invariant. Nothing this module returns
 * is ever a credential.
 *
 * @module @pagespace/lib/services/drive-envs/env-oauth-client
 */

import { isValidClientName } from '../../auth/oauth/client-registration';
import { buildPreviewHost } from '../sandbox/preview/preview-host';

/** `client_id` = this prefix + the env id. Public, deterministic, derivable by anything that knows the env. */
export const ENV_OAUTH_CLIENT_ID_PREFIX = 'env_';

/**
 * The callback path every zero-config app serves ([D-10]). The SDK carries the
 * same literal as `PAGESPACE_CALLBACK_PATH`; `@pagespace/lib` cannot import
 * `@pagespace/sdk` (the SDK depends on this package), so the two are pinned
 * equal by a test in `apps/web`, which depends on both.
 */
export const ENV_OAUTH_CALLBACK_PATH = '/auth/pagespace/callback';

/** The third-party scope SHAPES (ADR 0004 Decision 7) — the whole cap, nothing first-party. */
export const ENV_OAUTH_CLIENT_SCOPES: readonly string[] = ['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role'];

/** Browser sign-in and silent refresh. No device code: an env-hosted app is reached over the web. */
export const ENV_OAUTH_CLIENT_GRANT_TYPES: readonly string[] = ['authorization_code', 'refresh_token'];

/** What the consent screen shows when the env's own name cannot be rendered safely (see {@link deriveEnvClient}). */
export const ENV_OAUTH_CLIENT_FALLBACK_NAME = 'PageSpace environment';

export function envOAuthClientId(envId: string): string {
  return `${ENV_OAUTH_CLIENT_ID_PREFIX}${envId}`;
}

/** The env facts the derivation reads. `driveOwnerId` is the drive's owner — the client's owner, like every other bill for the env. */
export interface EnvClientSource {
  env: { id: string; name: string };
  driveOwnerId: string;
}

/** Where the env's app is reachable. Both halves are injected: the caller reads config and rows, this module reads nothing. */
export interface EnvClientHosting {
  /** The configured dev-preview apex (`resolveDevPreviewApex()`), or `null` when preview is not configured — then there is no preview origin to redirect to. */
  previewApex: string | null;
  /** The env's `published_apps` row, or `null` when it is not published. */
  published: {
    subdomain: string;
    /** The published-apps apex (`resolvePublishedAppsApex()`). */
    apex: string;
    /** Hostnames of the app's custom domains whose DNS ownership is proven. Case-insensitive; duplicates are dropped. */
    customDomains: readonly string[];
  } | null;
}

/** The `oauth_clients` columns the platform writes for an env. Structural, so this module stays free of `@pagespace/db`. */
export interface EnvOAuthClientRow {
  clientId: string;
  name: string;
  clientType: 'public';
  redirectUris: string[];
  allowedGrantTypes: string[];
  allowedScopes: string[];
  ownerUserId: string;
  verified: true;
  isFirstParty: false;
}

function callbackOn(host: string): string {
  return `https://${host}${ENV_OAUTH_CALLBACK_PATH}`;
}

/**
 * Pure: the redirect URIs an env's client holds — the preview origin's
 * callback, then (when published) the published subdomain's and each custom
 * domain's. Order is stable and entries are unique, so two derivations from
 * the same facts are byte-equal.
 */
export function envRedirectUris(envId: string, hosting: EnvClientHosting): string[] {
  const uris: string[] = [];
  if (hosting.previewApex !== null) {
    uris.push(callbackOn(buildPreviewHost({ kind: 'env', id: envId }, hosting.previewApex)));
  }
  if (hosting.published !== null) {
    uris.push(callbackOn(`${hosting.published.subdomain}.${hosting.published.apex}`));
    for (const domain of hosting.published.customDomains) {
      uris.push(callbackOn(domain.trim().toLowerCase()));
    }
  }
  return [...new Set(uris)];
}

/**
 * Pure: the client row for an env.
 *
 * The env's name is the client's name — it is what the consent screen shows
 * beside "requesting access" — unless it fails the consent-screen name rule
 * (bidi overrides, zero-width characters, whitespace-only, over-long), in
 * which case a fixed platform name is shown instead. An env name is a label a
 * drive admin typed, and the consent screen is a security surface (ADR 0002
 * Decision 5); substituting is safer than either rendering it or refusing to
 * provision the client.
 */
export function deriveEnvClient(source: EnvClientSource, hosting: EnvClientHosting): EnvOAuthClientRow {
  return {
    clientId: envOAuthClientId(source.env.id),
    name: isValidClientName(source.env.name) ? source.env.name : ENV_OAUTH_CLIENT_FALLBACK_NAME,
    clientType: 'public',
    redirectUris: envRedirectUris(source.env.id, hosting),
    allowedGrantTypes: [...ENV_OAUTH_CLIENT_GRANT_TYPES],
    allowedScopes: [...ENV_OAUTH_CLIENT_SCOPES],
    ownerUserId: source.driveOwnerId,
    verified: true,
    isFirstParty: false,
  };
}

/**
 * Pure: the origin the SDK should talk to, or `null` when the configured value
 * is unset or not an http(s) URL. Trailing slashes and any path are dropped —
 * `fromEnvironment` appends `/api/oauth/...` itself.
 */
function pagespaceOrigin(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

/**
 * Pure: the two PUBLIC values an app reads to sign users in —
 * `PAGESPACE_URL` (where PageSpace is) and `PAGESPACE_CLIENT_ID` (this env's
 * client). Handed to the sandbox (`sandbox-env.ts`) and to the published
 * machine (`app-hosting/build-core.ts`) from this ONE function, so the two
 * surfaces cannot spell the values differently.
 *
 * A value that is not known is OMITTED rather than emitted empty: the SDK's
 * `resolveEnvironmentConfig` names the missing variable in its error, which
 * is a better failure than a present-but-empty one. No env ⇒ no client id
 * (an ephemeral session sandbox has no client); no usable origin ⇒ no URL.
 */
export function signInEnvFor({ envId, pagespaceUrl }: { envId: string | null; pagespaceUrl: string | null | undefined }): Record<string, string> {
  const out: Record<string, string> = {};
  const origin = pagespaceOrigin(pagespaceUrl);
  if (origin !== null) out.PAGESPACE_URL = origin;
  if (envId !== null) out.PAGESPACE_CLIENT_ID = envOAuthClientId(envId);
  return out;
}

// ---------------------------------------------------------------------------
// The I/O half — the lifecycle verbs, over an injected store
// ---------------------------------------------------------------------------

/**
 * The two writes the lifecycle needs. The production store (`apps/web`,
 * `env-oauth-client-store.ts`) upserts on `clientId` and, on disable, revokes
 * every OAuth family the client issued through the Phase 1a revoke path.
 */
export interface EnvOAuthClientStore {
  /** Insert, or update every derived column of the existing row (and clear `disabledAt`). Same row in ⇒ same row stored. */
  upsert(row: EnvOAuthClientRow): Promise<void>;
  /** Set `disabledAt` (once) and revoke every live refresh/access family of the client. A missing or already-disabled row is a no-op. */
  disable(clientId: string): Promise<{ disabled: boolean; familiesRevoked: number }>;
}

export interface SyncEnvOAuthClientDeps {
  loadEnv(envId: string): Promise<EnvClientSource | null>;
  loadHosting(envId: string): Promise<EnvClientHosting>;
  store: Pick<EnvOAuthClientStore, 'upsert'>;
}

export type SyncEnvOAuthClientResult = { ok: true; row: EnvOAuthClientRow } | { ok: false; reason: 'env_not_found' };

/**
 * Bring the env's client row up to date with the env's current facts. Called
 * on env create, rename, first preview, publish, unpublish and custom-domain
 * change — every one of them the same call, because the row is a function of
 * the facts and not of the event: a publish ADDS the published redirect
 * without the preview one going anywhere, and an unpublish removes only it.
 */
export async function syncEnvOAuthClient({ envId, deps }: { envId: string; deps: SyncEnvOAuthClientDeps }): Promise<SyncEnvOAuthClientResult> {
  const source = await deps.loadEnv(envId);
  if (!source) return { ok: false, reason: 'env_not_found' };
  const row = deriveEnvClient(source, await deps.loadHosting(envId));
  await deps.store.upsert(row);
  return { ok: true, row };
}

/**
 * Env delete: disable the client and revoke everything it ever issued. The
 * env row may already be gone — the client id is derived from the env id, so
 * nothing needs to be read first.
 */
export async function retireEnvOAuthClient({ envId, deps }: { envId: string; deps: { store: Pick<EnvOAuthClientStore, 'disable'> } }): Promise<{
  clientId: string;
  disabled: boolean;
  familiesRevoked: number;
}> {
  const clientId = envOAuthClientId(envId);
  const outcome = await deps.store.disable(clientId);
  return { clientId, ...outcome };
}
