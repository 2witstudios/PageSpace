/** RED stub — `pagespace login` wiring lands in GREEN. */
import type { CredentialStore } from '../credentials/store.js';
import type { CommandHandler } from '../router/router.js';
import type {
  ConfirmIdentity,
  DiscoverMetadata,
  ExchangeCode,
  OpenBrowser,
  RandomBytes,
  StartLoopbackServer,
  WaitMs,
} from '../auth/loopback-flow.js';

export const DEFAULT_LOGIN_SCOPE = 'account offline_access';
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

export function createLoginHandler(_deps: LoginHandlerDeps): CommandHandler {
  return async () => {
    throw new Error('not implemented');
  };
}

export const loginHandler: CommandHandler = async () => {
  throw new Error('not implemented');
};
