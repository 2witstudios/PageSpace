/**
 * `pagespace whoami [--host <url>] [--json]` (Phase 4 task 5). For an
 * `oauth`-kind (OAuth refresh/access-token) credential, no access token is
 * cached between CLI invocations (`pagespace login` discards it once its own
 * `confirmIdentity` call has run), so every `whoami` call performs one
 * refresh_token grant to mint a fresh access token, reusing the same
 * discovery + `confirmIdentity` effects `pagespace login` uses.
 * Persist-before-use (ADR 0003 §3.5): the rotated refresh token is written
 * to the credential store BEFORE the new access token is used to call the
 * identity endpoint, so a crash between refresh and identity confirmation
 * never strands a rotated-away token. A `static`-kind credential (`pagespace
 * keys create`'s `mcp_*` token) has no refresh cycle at all — its stored
 * scopes ARE the current grant, and the token itself confirms identity
 * directly, no discovery/refresh effects needed.
 *
 * Non-interactive: a missing credential exits 1 immediately, never
 * prompting — safe in CI/non-TTY.
 */
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { confirmIdentity } from '../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import type { ConfirmIdentity, DiscoverMetadata } from '../auth/loopback-flow.js';
import { resolveEnvKeyName } from '../auth/legacy-token-env.js';
import { resolveKeyName } from '../auth/resolve.js';
import { createRefreshAccessToken } from '../auth/silent-refresh.js';
import type { RefreshAccessToken } from '@pagespace/sdk';

export interface WhoamiHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly discoverMetadata: DiscoverMetadata;
  readonly createRefreshAccessToken: (tokenEndpoint: string, clientId: string) => RefreshAccessToken;
  readonly confirmIdentity: ConfirmIdentity;
  readonly now: () => number;
}

export function createWhoamiHandler(deps: WhoamiHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      credential: null,
    });
    const keyName = resolveKeyName(
      { key: intent.flags.key },
      // The deprecated PAGESPACE_PROFILE alias folds in here (run.ts already
      // printed its one-line notice before dispatch).
      { PAGESPACE_KEY: resolveEnvKeyName(ctx.env).name },
    );

    const store = deps.createCredentialStore();
    const credential = await store.get(host, keyName);
    if (!credential) {
      ctx.stderr.write(`Not logged in to ${host}. Run "pagespace login".\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // A static (mcp) credential has no refresh cycle — mcp_* tokens don't
    // expire — so there is no live refresh response to reconcile scope
    // against; the credential's own stored scopes ARE the current grant, and
    // the token itself is used directly to confirm identity.
    let accessToken: string;
    let scopes: readonly string[];

    if (credential.kind === 'static') {
      accessToken = credential.token;
      scopes = credential.scopes;
    } else {
      let tokenEndpoint: string;
      try {
        tokenEndpoint = (await deps.discoverMetadata(host)).tokenEndpoint;
      } catch (error) {
        ctx.stderr.write(`Could not confirm identity on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_RUNTIME_ERROR;
      }

      let tokens;
      try {
        const doRefresh = deps.createRefreshAccessToken(tokenEndpoint, credential.clientId);
        tokens = await doRefresh(credential.refreshToken);
      } catch {
        ctx.stderr.write(`Not logged in to ${host}: stored credential was rejected. Run "pagespace login" again.\n`);
        return EXIT_RUNTIME_ERROR;
      }

      // Prefer the server's live, authoritative scope from this refresh over
      // the locally-cached value — whoami exists to confirm CURRENT grants,
      // and a refresh response scope reflects any server-side
      // narrowing/change since the credential was last stored. Fall back to
      // the stored scopes only if the transport didn't capture one.
      scopes = tokens.scope !== undefined ? tokens.scope.split(' ').filter(Boolean) : credential.scopes;
      await store.set(
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
      accessToken = tokens.accessToken;
    }

    let identity;
    try {
      identity = await deps.confirmIdentity({ host, accessToken });
    } catch (error) {
      ctx.stderr.write(`Could not confirm identity on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // The machine's active key for this host (`pagespace keys use`) — shown
    // whenever one is set, because it changes what a bare content command on
    // this machine will authenticate as.
    const activeKey = await ctx.activeKeyStore.getActiveKey(host);

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ host, name: identity.name, email: identity.email, scopes, activeKey })}\n`);
    } else {
      ctx.stdout.write(`Logged in as ${identity.name ?? identity.email} <${identity.email}> on ${host}.\n`);
      ctx.stdout.write(`Scopes: ${scopes.length > 0 ? scopes.join(' ') : '(none)'}\n`);
      if (activeKey !== null) {
        ctx.stdout.write(`Active key: ${activeKey}\n`);
      }
    }

    return EXIT_SUCCESS;
  };
}

export const whoamiHandler: CommandHandler = createWhoamiHandler({
  createCredentialStore,
  discoverMetadata: createDiscoverMetadata(),
  createRefreshAccessToken,
  confirmIdentity,
  now: Date.now,
});
