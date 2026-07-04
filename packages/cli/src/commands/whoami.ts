/**
 * `pagespace whoami [--host <url>] [--json]` (Phase 4 task 5). No access
 * token is cached between CLI invocations (`pagespace login` discards it
 * once its own `confirmIdentity` call has run), so every `whoami` call
 * performs one refresh_token grant to mint a fresh access token, reusing
 * the same discovery + `confirmIdentity` effects `pagespace login` uses.
 * Persist-before-use (ADR 0003 §3.5): the rotated refresh token is written
 * to the credential store BEFORE the new access token is used to call the
 * identity endpoint, so a crash between refresh and identity confirmation
 * never strands a rotated-away token.
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
import { createRefreshToken } from '../auth/refresh-token.js';
import type { RefreshToken } from '../auth/refresh-token.js';

export interface WhoamiHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly discoverMetadata: DiscoverMetadata;
  readonly refreshToken: RefreshToken;
  readonly confirmIdentity: ConfirmIdentity;
  readonly now: () => number;
}

export function createWhoamiHandler(deps: WhoamiHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      profile: null,
    });

    const store = deps.createCredentialStore();
    const credential = await store.get(host);
    if (!credential) {
      ctx.stderr.write(`Not logged in to ${host}. Run "pagespace login".\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let tokenEndpoint: string;
    try {
      tokenEndpoint = (await deps.discoverMetadata(host)).tokenEndpoint;
    } catch (error) {
      ctx.stderr.write(`Could not confirm identity on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let refreshed;
    try {
      refreshed = await deps.refreshToken({ tokenEndpoint, clientId: credential.clientId, refreshToken: credential.refreshToken });
    } catch {
      ctx.stderr.write(`Not logged in to ${host}: stored credential was rejected. Run "pagespace login" again.\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const scopes = refreshed.scope.split(' ').filter(Boolean);
    await store.set(host, {
      refreshToken: refreshed.refreshToken,
      clientId: credential.clientId,
      scopes,
      createdAt: new Date(deps.now()).toISOString(),
    });

    let identity;
    try {
      identity = await deps.confirmIdentity({ host, accessToken: refreshed.accessToken });
    } catch (error) {
      ctx.stderr.write(`Could not confirm identity on ${host}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ host, name: identity.name, email: identity.email, scopes })}\n`);
    } else {
      ctx.stdout.write(`Logged in as ${identity.name ?? identity.email} <${identity.email}> on ${host}.\n`);
      ctx.stdout.write(`Scopes: ${scopes.length > 0 ? scopes.join(' ') : '(none)'}\n`);
    }

    return EXIT_SUCCESS;
  };
}

export const whoamiHandler: CommandHandler = createWhoamiHandler({
  createCredentialStore,
  discoverMetadata: createDiscoverMetadata(),
  refreshToken: createRefreshToken(),
  confirmIdentity,
  now: Date.now,
});
