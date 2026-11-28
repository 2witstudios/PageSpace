/**
 * Wires a resolved `AuthSource` (Phase 4 task 7) to a real `AuthProvider`,
 * and enforces it before a command runs. Two effect edges only: discovery +
 * the refresh grant (both deferred until the first `getAccessToken()` call,
 * never at construction — so commands that never touch `ctx.sdk`, like
 * `help`, never trigger a network call just because a credential happens to be
 * stored) and the credential store (write the rotated refresh token on
 * success, purge it on a definitive failure).
 *
 * `--token`/env credentials build a `StaticTokenProvider` — used exactly as
 * given, never refreshed, never persisted (ADR 0003 §4; CI stays stateless).
 * A stored key/login credential builds an `OAuthTokenProvider` wired to this CLI's own
 * refresh effect. Zero credentials builds a `FailingAuthProvider` that fails
 * closed with an actionable, secret-free message — there is no interactive
 * fallback anywhere in this module, in a TTY or not.
 */
import { AuthenticationError, exchangeAgentAssertion, isAuthenticationError, OAuthTokenProvider, StaticTokenProvider } from '@pagespace/sdk';
import type { AuthProvider, OAuthTokens, RefreshAccessToken } from '@pagespace/sdk';
import { agentCredentialWithTokens, createAgentRefreshAccessToken } from './agent-session.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, type ExitCode } from '../exit-codes.js';
import type { OutputSink } from '../handler-context.js';
import { missingCredentialsMessage, type AuthSource } from './resolve.js';
import { formatCliError } from '../format-error.js';
import { credentialKindOf } from './credential-kind.js';

export interface DiscoveredTokenEndpoint {
  readonly tokenEndpoint: string;
}
export type DiscoverTokenEndpoint = (host: string) => Promise<DiscoveredTokenEndpoint>;

export class FailingAuthProvider implements AuthProvider {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  async getAccessToken(): Promise<string> {
    throw new AuthenticationError(this.#message);
  }

  invalidate(): void {
    // Nothing was ever issued; there is nothing to invalidate.
  }
}

/** The jwt-bearer exchange of an agent secret; the SDK's `exchangeAgentAssertion` by default. */
export type ExchangeAgentSecret = (tokenEndpoint: string, secret: string, clientId: string) => Promise<OAuthTokens>;

export interface BuildAuthProviderDeps {
  readonly discoverMetadata: DiscoverTokenEndpoint;
  readonly createRefreshAccessToken: (tokenEndpoint: string, clientId: string) => RefreshAccessToken;
  /** Only an agent credential ever reaches this; omitted, the SDK's real exchange is used. */
  readonly exchangeAgentAssertion?: ExchangeAgentSecret;
  readonly credentialStore: Pick<CredentialStore, 'set'>;
  readonly now: () => number;
}

export function buildAuthProvider(source: AuthSource, deps: BuildAuthProviderDeps): AuthProvider {
  switch (source.kind) {
    case 'flag':
    case 'env':
      return new StaticTokenProvider(source.token);

    case 'stored': {
      const { host, credential } = source;
      const keyName = source.keyName ?? DEFAULT_PROFILE_NAME;

      // A static (mcp) credential has no refresh cycle at all — mcp_* tokens
      // don't expire (see credentials/serialize.ts's StaticHostCredential
      // doc comment) — so it's used exactly as given, same as `--token`/env,
      // never refreshed or rewritten to the store.
      if (credential.kind === 'static') {
        return new StaticTokenProvider(credential.token);
      }

      // An agent's own account (ADR 0008): the refresh token is a cache of the
      // last exchange of the durable secret, so invalid_grant re-exchanges
      // (`agent-session.ts`) instead of failing. The persisted credential keeps
      // the secret — `agentCredentialWithTokens` only swaps the refresh token.
      if (credential.kind === 'agent') {
        const exchange: ExchangeAgentSecret =
          deps.exchangeAgentAssertion ?? ((endpoint: string, secret: string, clientId: string) => exchangeAgentAssertion(endpoint, secret, clientId));
        const refreshAccessToken: RefreshAccessToken = async (refreshToken) => {
          const { tokenEndpoint } = await deps.discoverMetadata(host);
          return createAgentRefreshAccessToken({
            secret: credential.secret,
            refresh: (refreshToken) => deps.createRefreshAccessToken(tokenEndpoint, credential.clientId)(refreshToken),
            exchange: (secret) => exchange(tokenEndpoint, secret, credential.clientId),
          })(refreshToken);
        };
        return new OAuthTokenProvider({
          initialTokens: {
            accessToken: '',
            accessExpiresAt: Number.NEGATIVE_INFINITY,
            refreshToken: credential.refreshToken ?? '',
            refreshExpiresAt: Number.POSITIVE_INFINITY,
          },
          refreshAccessToken,
          now: deps.now,
          onTokensUpdated: async (tokens: OAuthTokens) => {
            await deps.credentialStore.set(host, agentCredentialWithTokens(credential, tokens, deps.now()), keyName);
          },
        });
      }

      const refreshAccessToken: RefreshAccessToken = async (refreshToken) => {
        const metadata = await deps.discoverMetadata(host);
        const doRefresh = deps.createRefreshAccessToken(metadata.tokenEndpoint, credential.clientId);
        return doRefresh(refreshToken);
      };

      return new OAuthTokenProvider({
        // No access token is ever persisted to disk (only the refresh token
        // is stored, per the credentials/serialize.ts HostCredential shape),
        // so every fresh process starts "expired" and refreshes immediately.
        initialTokens: {
          accessToken: '',
          accessExpiresAt: Number.NEGATIVE_INFINITY,
          refreshToken: credential.refreshToken,
          refreshExpiresAt: Number.POSITIVE_INFINITY,
        },
        refreshAccessToken,
        now: deps.now,
        onTokensUpdated: async (tokens: OAuthTokens) => {
          // Prefer the server's live, authoritative scope from this refresh
          // over the locally-cached value (mirrors whoami.ts) — every
          // command refreshes via this same path, so this is what keeps a
          // server-side scope narrowing from silently going stale until the
          // user happens to run `whoami`.
          const scopes = tokens.scope !== undefined ? tokens.scope.split(' ').filter(Boolean) : credential.scopes;
          await deps.credentialStore.set(
            host,
            {
              kind: 'oauth',
              refreshToken: tokens.refreshToken,
              clientId: credential.clientId,
              scopes,
              createdAt: new Date(deps.now()).toISOString(),
            },
            keyName,
          );
        },
      });
    }

    case 'none':
      return new FailingAuthProvider(missingCredentialsMessage(source.host));
  }
}

export interface EnforceAuthDeps {
  readonly auth: Pick<AuthProvider, 'getAccessToken'>;
  readonly source: AuthSource;
  readonly credentialStore: Pick<CredentialStore, 'delete'>;
  readonly stderr: OutputSink;
}

/**
 * Materializes an access token before a command runs. Returns `null` when
 * auth is good to go (the token is now cached on `deps.auth`, so the
 * command's own use of it is free). On failure, returns the `ExitCode` the
 * caller should return immediately instead of dispatching the command —
 * never prompts, regardless of TTY.
 */
export async function enforceAuth(deps: EnforceAuthDeps): Promise<ExitCode | null> {
  try {
    await deps.auth.getAccessToken();
    return null;
  } catch (error) {
    // An agent secret is never deleted on a failure: `invalid_grant` is the
    // same answer for a rotated secret and a temporarily locked agent, and the
    // secret is the only way back into the account.
    if (deps.source.kind === 'stored' && deps.source.credential.kind === 'agent' && isAuthenticationError(error)) {
      deps.stderr.write(
        `The agent credential stored for ${deps.source.host} could not be refreshed, and its secret was refused. ` +
          'If the secret was rotated elsewhere, sign in with the new one: pipe it to "pagespace login --agent --yes".\n',
      );
      return EXIT_RUNTIME_ERROR;
    }

    if (deps.source.kind === 'stored' && isAuthenticationError(error)) {
      await deps.credentialStore.delete(deps.source.host, deps.source.keyName ?? DEFAULT_PROFILE_NAME);
      // A static (mcp) credential has no refresh cycle to fail — this only
      // fires once the token itself has been rejected (revoked/invalid), so
      // "log in again" is the wrong remediation: there's no login session to
      // refresh, only a key to re-mint.
      deps.stderr.write(
        deps.source.credential.kind === 'static'
          ? `Your stored key for ${deps.source.host} was rejected. Re-mint it with "pagespace keys create" (or "pagespace keys" for the guided wizard).\n`
          : `Your stored credentials for ${deps.source.host} could not be refreshed. Run "pagespace login" again.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    deps.stderr.write(`${formatCliError(error, credentialKindOf(deps.source))}\n`);
    return EXIT_RUNTIME_ERROR;
  }
}
