/**
 * Wires a resolved `AuthSource` (Phase 4 task 7) to a real `AuthProvider`,
 * and enforces it before a command runs. Two effect edges only: discovery +
 * the refresh grant (both deferred until the first `getAccessToken()` call,
 * never at construction — so commands that never touch `ctx.sdk`, like
 * `help`, never trigger a network call just because a profile happens to be
 * stored) and the credential store (write the rotated refresh token on
 * success, purge it on a definitive failure).
 *
 * `--token`/env credentials build a `StaticTokenProvider` — used exactly as
 * given, never refreshed, never persisted (ADR 0003 §4; CI stays stateless).
 * A stored profile builds an `OAuthTokenProvider` wired to this CLI's own
 * refresh effect. Zero credentials builds a `FailingAuthProvider` that fails
 * closed with an actionable, secret-free message — there is no interactive
 * fallback anywhere in this module, in a TTY or not.
 */
import { AuthenticationError, isAuthenticationError, OAuthTokenProvider, StaticTokenProvider } from '@pagespace/sdk';
import type { AuthProvider, OAuthTokens, RefreshAccessToken } from '@pagespace/sdk';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, type ExitCode } from '../exit-codes.js';
import type { OutputSink } from '../handler-context.js';
import { missingCredentialsMessage, type AuthSource } from './resolve.js';

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

export interface BuildAuthProviderDeps {
  readonly discoverMetadata: DiscoverTokenEndpoint;
  readonly createRefreshAccessToken: (tokenEndpoint: string, clientId: string) => RefreshAccessToken;
  readonly credentialStore: Pick<CredentialStore, 'set'>;
  readonly now: () => number;
}

export function buildAuthProvider(source: AuthSource, deps: BuildAuthProviderDeps): AuthProvider {
  switch (source.kind) {
    case 'flag':
    case 'env':
      return new StaticTokenProvider(source.token);

    case 'profile': {
      const { host, credential } = source;
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
          await deps.credentialStore.set(host, {
            refreshToken: tokens.refreshToken,
            clientId: credential.clientId,
            scopes: credential.scopes,
            createdAt: new Date(deps.now()).toISOString(),
          });
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
    if (deps.source.kind === 'profile' && isAuthenticationError(error)) {
      await deps.credentialStore.delete(deps.source.host);
      deps.stderr.write(
        `Your stored credentials for ${deps.source.host} could not be refreshed. Run "pagespace login" again.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_RUNTIME_ERROR;
  }
}
