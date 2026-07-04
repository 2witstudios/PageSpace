/**
 * runLoopbackLogin — the pure orchestration core of `pagespace login`
 * (Phase 4 task 3). RED stub: types are frozen so the RED test suite
 * compiles against the real contract; the implementation lands in GREEN.
 */
import type { CredentialStore } from '../credentials/store.js';

export interface DiscoveredMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}
export type DiscoverMetadata = (host: string) => Promise<DiscoveredMetadata>;

export interface LoopbackCallback {
  readonly query: Readonly<Record<string, string>>;
}

export interface LoopbackServer {
  readonly port: number;
  nextCallback(): Promise<LoopbackCallback>;
  finish(html: string): Promise<void>;
  close(): Promise<void>;
}
export type StartLoopbackServer = () => Promise<LoopbackServer>;

export type OpenBrowser = (url: string) => Promise<boolean>;
export type RandomBytes = (length: number) => Uint8Array;
export type WaitMs = (ms: number) => Promise<void>;

export interface ExchangedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}
export interface ExchangeCodeParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}
export type ExchangeCode = (params: ExchangeCodeParams) => Promise<ExchangedTokens>;

export interface Identity {
  readonly name: string | null;
  readonly email: string;
}
export type ConfirmIdentity = (params: { host: string; accessToken: string }) => Promise<Identity>;

export interface LoopbackLoginDeps {
  readonly host: string;
  readonly clientId: string;
  readonly scope: string;
  readonly randomBytes: RandomBytes;
  readonly discoverMetadata: DiscoverMetadata;
  readonly startServer: StartLoopbackServer;
  readonly maxPortAttempts: number;
  readonly openBrowser: OpenBrowser;
  readonly onBrowserOpenFailed: (url: string) => void;
  readonly waitMs: WaitMs;
  readonly timeoutMs: number;
  readonly exchangeCode: ExchangeCode;
  readonly confirmIdentity: ConfirmIdentity;
  readonly credentialStore: Pick<CredentialStore, 'set'>;
  readonly now: () => number;
}

export type LoopbackLoginResult =
  | { readonly outcome: 'success'; readonly identity: Identity | null }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'state_mismatch' }
  | { readonly outcome: 'access_denied' }
  | { readonly outcome: 'authorize_error'; readonly error: string }
  | { readonly outcome: 'token_exchange_failed'; readonly message: string }
  | { readonly outcome: 'port_bind_failed' }
  | { readonly outcome: 'discovery_failed'; readonly message: string };

export async function runLoopbackLogin(_deps: LoopbackLoginDeps): Promise<LoopbackLoginResult> {
  throw new Error('not implemented');
}
