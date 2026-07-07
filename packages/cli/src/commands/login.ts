/**
 * `pagespace login` (Phase 4 task 3) — the headline CLI command. Wires the
 * pure `runLoopbackLogin` state machine (`auth/loopback-flow.ts`) to real
 * effects (discovery fetch, loopback HTTP server, browser opener, token
 * exchange, identity confirmation, the multi-host credential store) and maps
 * every outcome to a distinct, actionable, secret-free message.
 *
 * Constructs its own `CredentialStore` rather than reading `ctx.credentialStore`
 * (still the single-profile placeholder pending the generic auth-precedence
 * wiring of Phase 4 task 7) — this command is the real store's first
 * consumer either way.
 */
import { randomBytes } from 'node:crypto';
import { PAGESPACE_CLI_CLIENT_ID } from '../auth/client.js';
import { resolveConfig } from '../config/resolve.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { confirmIdentity } from '../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import { createExchangeCode } from '../auth/exchange-code.js';
import { createLoopbackServer } from '../auth/create-loopback-server.js';
import { openBrowser } from '../auth/open-browser.js';
import { runLoopbackLogin } from '../auth/loopback-flow.js';
import { resolveProfileName } from '../auth/resolve.js';
import type {
  ConfirmIdentity,
  DiscoverMetadata,
  ExchangeCode,
  OpenBrowser,
  RandomBytes,
  StartLoopbackServer,
  WaitMs,
} from '../auth/loopback-flow.js';

export const DEFAULT_LOGIN_SCOPE = 'manage_keys offline_access';
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_PORT_ATTEMPTS = 5;

export interface LoginHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly randomBytes: RandomBytes;
  readonly discoverMetadata: DiscoverMetadata;
  readonly startServer: StartLoopbackServer;
  readonly openBrowser: OpenBrowser;
  readonly waitMs: WaitMs;
  readonly exchangeCode: ExchangeCode;
  readonly confirmIdentity: ConfirmIdentity;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly maxPortAttempts?: number;
}

export function createLoginHandler(deps: LoginHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      profile: null,
    });
    const profileName = resolveProfileName(
      { profile: intent.flags.profile },
      { PAGESPACE_PROFILE: ctx.env.PAGESPACE_PROFILE },
    );

    const store = deps.createCredentialStore();
    const existing = await store.get(host, profileName);
    if (existing && !intent.flags.yes) {
      const profileNote = profileName === DEFAULT_PROFILE_NAME ? '' : ` (profile "${profileName}")`;
      ctx.stderr.write(
        `A stored credential for ${host}${profileNote} already exists. Re-run with --yes to overwrite it, or "pagespace logout --host ${host}" first.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    ctx.stdout.write(`Opening your browser to log in to ${host}...\n`);

    const result = await runLoopbackLogin({
      host,
      clientId: PAGESPACE_CLI_CLIENT_ID,
      scope: DEFAULT_LOGIN_SCOPE,
      randomBytes: deps.randomBytes,
      discoverMetadata: deps.discoverMetadata,
      startServer: deps.startServer,
      maxPortAttempts: deps.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
      openBrowser: deps.openBrowser,
      onBrowserOpenFailed: (url) => {
        ctx.stderr.write(`Could not open a browser automatically. Open this URL to continue:\n${url}\n`);
      },
      waitMs: deps.waitMs,
      timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      exchangeCode: deps.exchangeCode,
      confirmIdentity: deps.confirmIdentity,
      credentialStore: store,
      now: deps.now,
      profile: profileName,
    });

    switch (result.outcome) {
      case 'success':
        ctx.stdout.write(
          result.identity
            ? `Logged in as ${result.identity.name ?? result.identity.email} <${result.identity.email}> on ${host}.\n`
            : `Logged in to ${host}.\n`,
        );
        ctx.stdout.write(
          `Scope: ${result.scope} — key-management access only, with zero content access; run "pagespace keys create" to mint a scoped key for actual content access.\n`,
        );
        return EXIT_SUCCESS;
      case 'timeout':
        ctx.stderr.write('Login timed out waiting for the browser redirect. Run "pagespace login" again.\n');
        return EXIT_RUNTIME_ERROR;
      case 'state_mismatch':
        ctx.stderr.write(
          'Login failed: the authorization response did not match this login attempt. Run "pagespace login" again.\n',
        );
        return EXIT_RUNTIME_ERROR;
      case 'access_denied':
        ctx.stderr.write('Login was denied.\n');
        return EXIT_RUNTIME_ERROR;
      case 'authorize_error':
        ctx.stderr.write(`Login failed: ${result.error}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'token_exchange_failed':
        ctx.stderr.write(`Login failed while exchanging the authorization code: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'port_bind_failed':
        ctx.stderr.write('Could not bind a local loopback port to receive the login redirect.\n');
        return EXIT_RUNTIME_ERROR;
      case 'discovery_failed':
        ctx.stderr.write(`Could not discover the OAuth server configuration for ${host}: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled login outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

function nodeRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export const loginHandler: CommandHandler = createLoginHandler({
  createCredentialStore,
  randomBytes: nodeRandomBytes,
  discoverMetadata: createDiscoverMetadata(),
  startServer: createLoopbackServer,
  openBrowser,
  waitMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exchangeCode: createExchangeCode(),
  confirmIdentity,
  now: Date.now,
});
