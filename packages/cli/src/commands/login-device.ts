/**
 * `pagespace login --device` (Phase 4 task 4) — the headless counterpart to
 * `login.ts`. Wires the pure `runDeviceLogin` state machine
 * (`auth/device-flow.ts`) to real effects (discovery, device-authorization
 * request, token polling, the multi-host credential store, identity
 * confirmation) and prints the verification code/URL — this flow never
 * opens a browser, by RFC 8628 design.
 *
 * Constructs its own `CredentialStore` rather than reading
 * `ctx.credentialStore`, matching `login.ts` (task 3) — the generic
 * auth-precedence wiring into the command context factory is task 7's scope.
 */
import { PAGESPACE_CLI_CLIENT_ID } from '../auth/client.js';
import { resolveConfig } from '../config/resolve.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { confirmIdentity } from '../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import { createPollDeviceToken } from '../auth/poll-device-token.js';
import { createRequestDeviceAuthorization } from '../auth/request-device-authorization.js';
import { resolveEnvKeyName } from '../auth/legacy-token-env.js';
import { resolveKeyName } from '../auth/resolve.js';
import { createSigintFlag } from '../auth/sigint.js';
import { waitMs } from '../auth/wait.js';
import { runDeviceLogin } from '../auth/device-flow.js';
import type { DeviceAuthorization, PollDeviceToken, RequestDeviceAuthorization } from '../auth/device-flow.js';
import type { ConfirmIdentity, DiscoverMetadata, WaitMs } from '../auth/loopback-flow.js';
import { DEFAULT_LOGIN_SCOPE } from './login.js';

export interface LoginDeviceHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly discoverMetadata: DiscoverMetadata;
  readonly requestDeviceAuthorization: RequestDeviceAuthorization;
  readonly pollDeviceToken: PollDeviceToken;
  readonly waitMs: WaitMs;
  readonly confirmIdentity: ConfirmIdentity;
  readonly now: () => number;
  /**
   * Creates the interrupt flag. A factory, not a flag: calling it installs a
   * `process.once('SIGINT')` listener, which replaces Node's default
   * terminate-on-Ctrl-C. `run.ts` imports this module for every invocation, so
   * calling it at module scope would impose that on unrelated commands. The
   * handler calls it only once a device login is actually starting.
   */
  readonly createIsInterrupted: () => () => boolean;
  readonly timeoutMs?: number;
}

export function createLoginDeviceHandler(deps: LoginDeviceHandlerDeps): CommandHandler {
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
    const existing = await store.get(host, keyName);
    if (existing && !intent.flags.yes) {
      const keyNote = keyName === DEFAULT_PROFILE_NAME ? '' : ` (key "${keyName}")`;
      ctx.stderr.write(
        `A stored credential for ${host}${keyNote} already exists. Re-run with --yes to overwrite it, or "pagespace logout --host ${host}" first.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

    const result = await runDeviceLogin({
      host,
      clientId: PAGESPACE_CLI_CLIENT_ID,
      scope: DEFAULT_LOGIN_SCOPE,
      discoverMetadata: deps.discoverMetadata,
      requestDeviceAuthorization: deps.requestDeviceAuthorization,
      pollDeviceToken: deps.pollDeviceToken,
      waitMs: deps.waitMs,
      now: deps.now,
      isInterrupted: deps.createIsInterrupted(),
      timeoutMs: deps.timeoutMs,
      credentialStore: store,
      confirmIdentity: deps.confirmIdentity,
      profile: keyName,
      onDeviceCode: (authorization: DeviceAuthorization) => {
        ctx.stdout.write(`To finish signing in, visit:\n  ${authorization.verificationUri}\n`);
        ctx.stdout.write(`And enter this code: ${authorization.userCode}\n`);
        ctx.stdout.write(`Or open directly: ${authorization.verificationUriComplete}\n`);
      },
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
      case 'access_denied':
        ctx.stderr.write('Login was denied.\n');
        return EXIT_RUNTIME_ERROR;
      case 'expired_token':
        ctx.stderr.write('The device code expired before login completed. Run "pagespace login --device" again.\n');
        return EXIT_RUNTIME_ERROR;
      case 'timeout':
        ctx.stderr.write('Login timed out waiting for approval. Run "pagespace login --device" again.\n');
        return EXIT_RUNTIME_ERROR;
      case 'poll_failed':
        ctx.stderr.write(`Login failed while polling for a token: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'interrupted':
        ctx.stderr.write('Login cancelled.\n');
        return EXIT_RUNTIME_ERROR;
      case 'discovery_failed':
        ctx.stderr.write(`Could not discover the OAuth server configuration for ${host}: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      case 'device_authorization_failed':
        ctx.stderr.write(`Could not start device login: ${result.message}\n`);
        return EXIT_RUNTIME_ERROR;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled login outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

export const loginDeviceHandler: CommandHandler = createLoginDeviceHandler({
  createCredentialStore,
  discoverMetadata: createDiscoverMetadata(),
  requestDeviceAuthorization: createRequestDeviceAuthorization(),
  pollDeviceToken: createPollDeviceToken(),
  // The REF'D variant, deliberately: between polls this timer is often the
  // only live handle, so `unrefWaitMs` would let the process exit mid-poll
  // before the user ever approves the device (see auth/wait.ts).
  waitMs,
  confirmIdentity,
  now: Date.now,
  createIsInterrupted: createSigintFlag,
});
