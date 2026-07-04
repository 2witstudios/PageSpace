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
import { PAGESPACE_CLI_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { confirmIdentity } from '../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../auth/discover.js';
import { createPollDeviceToken } from '../auth/poll-device-token.js';
import { createRequestDeviceAuthorization } from '../auth/request-device-authorization.js';
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
  readonly isInterrupted: () => boolean;
  readonly timeoutMs?: number;
}

export function createLoginDeviceHandler(_deps: LoginDeviceHandlerDeps): CommandHandler {
  return async (_ctx, _intent) => {
    throw new Error('not implemented');
  };
}

function printDeviceCode(_authorization: DeviceAuthorization): void {
  throw new Error('not implemented');
}

function nodeWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSigintFlag(): () => boolean {
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
  });
  return () => interrupted;
}

export const loginDeviceHandler: CommandHandler = createLoginDeviceHandler({
  createCredentialStore,
  discoverMetadata: createDiscoverMetadata(),
  requestDeviceAuthorization: createRequestDeviceAuthorization(),
  pollDeviceToken: createPollDeviceToken(),
  waitMs: nodeWaitMs,
  confirmIdentity,
  now: Date.now,
  isInterrupted: createSigintFlag(),
});
