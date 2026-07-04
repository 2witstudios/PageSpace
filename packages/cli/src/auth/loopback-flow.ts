/**
 * runLoopbackLogin — the pure orchestration core of `pagespace login`
 * (Phase 4 task 3). A single state machine over injected effects (discovery,
 * loopback server, browser, clock/timeout, randomness, token exchange,
 * identity confirmation, credential store) — no `fetch`, `http`, `crypto`, or
 * `process.*` reference lives in this file. Every branch (timeout, state
 * mismatch, access_denied, token-exchange failure, port-bind exhaustion,
 * discovery failure) is a distinct `LoopbackLoginResult` variant so callers
 * never need to inspect an error message to decide what happened.
 *
 * PKCE math (`generateCodeVerifier`/`deriveCodeChallenge`) is reused from the
 * provider-side implementation rather than reinvented — the derivation is
 * the same SHA256/base64url math regardless of which side of the exchange
 * calls it.
 *
 * `LoopbackLoginResult`'s `success` case deliberately carries only
 * `identity`, never the access/refresh tokens — the tokens exist solely
 * inside this function's local scope between exchange and persistence, so
 * no caller can accidentally print or log one.
 */
import { deriveCodeChallenge, generateCodeVerifier } from '@pagespace/lib/auth/oauth/pkce';
import type { CredentialStore } from '../credentials/store.js';

export interface DiscoveredMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** RFC 8628 §4 — present when the server supports the device-authorization grant; read by `device-flow.ts`. */
  readonly deviceAuthorizationEndpoint?: string;
}
export type DiscoverMetadata = (host: string) => Promise<DiscoveredMetadata>;

export interface LoopbackCallback {
  readonly query: Readonly<Record<string, string>>;
}

/** A single-use loopback HTTP server bound to 127.0.0.1 at an ephemeral port. */
export interface LoopbackServer {
  readonly port: number;
  /** Resolves with the query params of the first request the server receives. */
  nextCallback(): Promise<LoopbackCallback>;
  /** Sends the terminal HTML page back for the request `nextCallback()` resolved. */
  finish(html: string): Promise<void>;
  close(): Promise<void>;
}
export type StartLoopbackServer = () => Promise<LoopbackServer>;

export type OpenBrowser = (url: string) => Promise<boolean>;
export type RandomBytes = (length: number) => Uint8Array;
/** Resolves after `ms` — the hard-timeout side of the callback race. */
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
  /** Space-delimited scope string (RFC 6749 §3.3), e.g. `"account offline_access"`. */
  readonly scope: string;
  readonly randomBytes: RandomBytes;
  readonly discoverMetadata: DiscoverMetadata;
  readonly startServer: StartLoopbackServer;
  readonly maxPortAttempts: number;
  readonly openBrowser: OpenBrowser;
  /** Called with the authorize URL when `openBrowser` fails, so the caller can print it (SSH-friendly). */
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

const CALLBACK_PATH = '/callback';

const SUCCESS_HTML =
  "<!doctype html><html><head><title>PageSpace</title></head><body><p>You're logged in — return to your terminal.</p></body></html>";
const ERROR_HTML =
  '<!doctype html><html><head><title>PageSpace</title></head><body><p>Login failed — return to your terminal.</p></body></html>';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function tryStartServer(deps: LoopbackLoginDeps): Promise<LoopbackServer | null> {
  for (let attempt = 0; attempt < deps.maxPortAttempts; attempt += 1) {
    try {
      return await deps.startServer();
    } catch {
      continue;
    }
  }
  return null;
}

function buildAuthorizeUrl(params: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scope: string;
  readonly state: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  return url.toString();
}

export async function runLoopbackLogin(deps: LoopbackLoginDeps): Promise<LoopbackLoginResult> {
  let metadata: DiscoveredMetadata;
  try {
    metadata = await deps.discoverMetadata(deps.host);
  } catch (error) {
    return { outcome: 'discovery_failed', message: error instanceof Error ? error.message : String(error) };
  }

  const server = await tryStartServer(deps);
  if (server === null) {
    return { outcome: 'port_bind_failed' };
  }

  try {
    const verifier = generateCodeVerifier(deps.randomBytes(32));
    const challenge = deriveCodeChallenge(verifier);
    const state = toBase64Url(deps.randomBytes(16));
    const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: deps.clientId,
      redirectUri,
      codeChallenge: challenge,
      scope: deps.scope,
      state,
    });

    const opened = await deps.openBrowser(authorizeUrl);
    if (!opened) {
      deps.onBrowserOpenFailed(authorizeUrl);
    }

    const raced = await Promise.race([
      server.nextCallback().then((callback) => ({ kind: 'callback' as const, callback })),
      deps.waitMs(deps.timeoutMs).then(() => ({ kind: 'timeout' as const })),
    ]);

    if (raced.kind === 'timeout') {
      return { outcome: 'timeout' };
    }

    const { query } = raced.callback;

    if (query.error) {
      await server.finish(ERROR_HTML);
      return query.error === 'access_denied' ? { outcome: 'access_denied' } : { outcome: 'authorize_error', error: query.error };
    }

    if (query.state !== state) {
      await server.finish(ERROR_HTML);
      return { outcome: 'state_mismatch' };
    }

    if (!query.code) {
      await server.finish(ERROR_HTML);
      return { outcome: 'token_exchange_failed', message: 'Authorization callback did not include a code.' };
    }

    let tokens: ExchangedTokens;
    try {
      tokens = await deps.exchangeCode({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: deps.clientId,
        code: query.code,
        redirectUri,
        codeVerifier: verifier,
      });
    } catch (error) {
      await server.finish(ERROR_HTML);
      return { outcome: 'token_exchange_failed', message: error instanceof Error ? error.message : String(error) };
    }

    await deps.credentialStore.set(deps.host, {
      refreshToken: tokens.refreshToken,
      clientId: deps.clientId,
      scopes: tokens.scope.split(' ').filter(Boolean),
      createdAt: new Date(deps.now()).toISOString(),
    });

    await server.finish(SUCCESS_HTML);

    let identity: Identity | null;
    try {
      identity = await deps.confirmIdentity({ host: deps.host, accessToken: tokens.accessToken });
    } catch {
      identity = null;
    }

    return { outcome: 'success', identity };
  } finally {
    await server.close();
  }
}
