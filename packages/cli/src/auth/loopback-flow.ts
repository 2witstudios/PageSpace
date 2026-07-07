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
 * PKCE math (`generateCodeVerifier`/`deriveCodeChallenge`) comes from
 * `@pagespace/sdk` rather than being reinvented here — the derivation is the
 * same SHA256/base64url math regardless of which side of the exchange calls
 * it, and importing the SDK (an existing CLI dependency) keeps this package
 * free of a runtime `@pagespace/lib` import.
 *
 * `LoopbackLoginResult`'s `success` case deliberately carries only
 * `identity` and the server's granted `scope` (RFC 6749 §5.1 — the server
 * may return a narrower scope than requested), never the access/refresh
 * tokens — the tokens exist solely inside this function's local scope
 * between exchange and persistence, so no caller can accidentally print or
 * log one. The single deliberate exception is the opt-in
 * `onMintedStaticToken` callback (see its doc on `LoopbackLoginDeps`),
 * which fires only for a static `mcp_*` mint — the wizard's show-once
 * "copy it for .env/CI" affordance — and never for the oauth pair.
 */
import { deriveCodeChallenge, generateCodeVerifier } from '@pagespace/sdk';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
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

/**
 * Discriminated on the token endpoint's `token_type` (`exchange-code.ts`):
 * `'oauth'` is the classic refresh/access-token pair `pagespace login`
 * always gets and `pagespace keys create` got before this fix. `'mcp'` is a
 * pure drive:* grant — the server minted a real `mcp_*` token instead (see
 * `oauth-repository.ts`'s `ok_mcp_token` outcome), with no refresh cycle.
 * `'mcp_update'` is an `update_key:<id>` grant — the server re-scoped an
 * EXISTING `mcp_*` token in place (`ok_mcp_update`) and returned no secret
 * at all; the flow below persists nothing for it.
 */
export type ExchangedTokens =
  | { readonly kind: 'oauth'; readonly accessToken: string; readonly refreshToken: string; readonly expiresIn: number; readonly scope: string }
  | { readonly kind: 'mcp'; readonly token: string; readonly scope: string }
  | { readonly kind: 'mcp_update'; readonly tokenId: string; readonly scope: string };
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
  /** Which named profile to store the credential under. Defaults to `"default"`. */
  readonly profile?: string;
  /**
   * Opt-in escape hatch for this file's "tokens never leave this function"
   * rule (header comment): invoked synchronously with the raw `mcp_*` token,
   * immediately after persistence, ONLY when the exchange minted a static
   * (`kind: 'mcp'`) token — never for the oauth refresh/access pair, so
   * `pagespace login` cannot surface a secret even if it wired this.
   * Callers must capture-and-defer, never print inside the callback (the
   * wizard has a spinner running at invocation time).
   */
  readonly onMintedStaticToken?: (token: string) => void;
}

export type LoopbackLoginResult =
  | {
      readonly outcome: 'success';
      readonly identity: Identity | null;
      readonly scope: string;
      /** Set only for an `mcp_update` exchange — which existing key was re-scoped in place (no credential was stored). */
      readonly updatedTokenId?: string;
    }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'state_mismatch' }
  | { readonly outcome: 'access_denied' }
  | { readonly outcome: 'authorize_error'; readonly error: string }
  | { readonly outcome: 'token_exchange_failed'; readonly message: string }
  | { readonly outcome: 'port_bind_failed' }
  | { readonly outcome: 'discovery_failed'; readonly message: string };

export const CALLBACK_PATH = '/callback';

/**
 * Light-mode hex values are copied from `packages/lib/src/email-templates/shared-styles.ts`
 * (`colors.pageBackground`, `colors.heading`, `colors.text`, `colors.mutedText`, `colors.primary`,
 * `colors.border`, `colors.accent`, `shadows.md`) — the repo's one existing precise conversion of
 * these OKLCH design tokens to hex, done for the transactional emails. Reusing those values here
 * keeps this page in sync instead of re-deriving a second, drifting approximation. Success/error
 * accent colors have no email-template equivalent, so they're approximated directly from
 * `apps/web/src/app/globals.css`'s `--success`/`--destructive` tokens. Dark-mode values have no
 * existing source (email templates don't support dark mode) and are approximated the same way.
 */
const CALLBACK_PAGE_STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: #F8F9FB;
      color: #2C3442;
    }
    .card {
      max-width: 360px;
      width: calc(100% - 48px);
      padding: 32px;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06);
      text-align: center;
    }
    .badge {
      width: 56px;
      height: 56px;
      margin: 0 auto 20px;
      border-radius: 9999px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .badge svg { width: 28px; height: 28px; }
    .badge--success { background: rgba(34, 160, 107, 0.12); color: #22a06b; }
    .badge--error { background: rgba(220, 68, 68, 0.12); color: #dc4444; }
    .wordmark { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; color: #3D64C8; margin: 0 0 16px; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; color: #111723; }
    p { font-size: 14px; line-height: 1.5; color: #697386; margin: 0; }
    button {
      margin-top: 24px;
      padding: 10px 20px;
      border-radius: 8px;
      border: 1px solid #E4E6EA;
      background: transparent;
      color: #2C3442;
      font: inherit;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
    }
    button:hover { background: #F0F1F4; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #eeeeee; }
      .card { background: #262626; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35); }
      .badge--success { background: rgba(79, 185, 138, 0.16); color: #4fb98a; }
      .badge--error { background: rgba(226, 87, 74, 0.16); color: #e2574a; }
      .wordmark { color: #4a90c9; }
      h1 { color: #eeeeee; }
      p { color: #a8adb5; }
      button { border-color: #3a3a3a; color: #eeeeee; }
      button:hover { background: #2f2f2f; }
    }
`;

const SUCCESS_ICON_PATH = '<path d="M5 13l4 4L19 7"/>';
const ERROR_ICON_PATH = '<path d="M6 6l12 12M18 6L6 18"/>';

function buildCallbackPage(params: {
  readonly badgeVariant: 'success' | 'error';
  readonly iconPath: string;
  readonly heading: string;
  readonly subtext: string;
  readonly closeButton: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageSpace</title>
<style>${CALLBACK_PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="badge badge--${params.badgeVariant}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${params.iconPath}</svg>
    </div>
    <p class="wordmark">PageSpace</p>
    <h1>${params.heading}</h1>
    <p>${params.subtext}</p>
    ${params.closeButton ? '<button onclick="window.close()">Close this tab</button>' : ''}
  </div>
</body>
</html>`;
}

const SUCCESS_HTML = buildCallbackPage({
  badgeVariant: 'success',
  iconPath: SUCCESS_ICON_PATH,
  heading: "You're logged in",
  subtext: 'You can close this tab and return to your terminal.',
  closeButton: true,
});

const ERROR_HTML = buildCallbackPage({
  badgeVariant: 'error',
  iconPath: ERROR_ICON_PATH,
  heading: 'Login failed',
  subtext: 'Return to your terminal and try again.',
  closeButton: false,
});

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

    // An mcp_update exchange re-scoped an EXISTING key in place: the server
    // returned no secret, the locally stored credential (if any) is
    // unchanged, and there is no bearer in hand for confirmIdentity — so
    // nothing is persisted and no identity call is made.
    if (tokens.kind === 'mcp_update') {
      await server.finish(SUCCESS_HTML);
      return { outcome: 'success', identity: null, scope: tokens.scope, updatedTokenId: tokens.tokenId };
    }

    const scopes = tokens.scope.split(' ').filter(Boolean);
    const createdAt = new Date(deps.now()).toISOString();

    await deps.credentialStore.set(
      deps.host,
      tokens.kind === 'oauth'
        ? { kind: 'oauth', refreshToken: tokens.refreshToken, clientId: deps.clientId, scopes, createdAt }
        : { kind: 'static', token: tokens.token, scopes, createdAt },
      deps.profile ?? DEFAULT_PROFILE_NAME,
    );

    if (tokens.kind === 'mcp') {
      deps.onMintedStaticToken?.(tokens.token);
    }

    await server.finish(SUCCESS_HTML);

    let identity: Identity | null;
    try {
      identity = await deps.confirmIdentity({ host: deps.host, accessToken: tokens.kind === 'oauth' ? tokens.accessToken : tokens.token });
    } catch {
      identity = null;
    }

    return { outcome: 'success', identity, scope: tokens.scope };
  } finally {
    await server.close();
  }
}
