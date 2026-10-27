/**
 * runDeviceLogin — the pure orchestration core of `pagespace login --device`
 * (RFC 8628 device-authorization grant, Phase 4 task 4). Mirrors
 * `loopback-flow.ts`'s shape: a state machine over injected effects (device
 * authorization request, discovery, token polling, clock, credential store,
 * identity confirmation) — no `fetch`, `crypto`, `setTimeout`, or
 * `process.*` reference lives in this file.
 *
 * `decideNextPoll` is the one function this module exists to make
 * unit-testable in total isolation: given the current poll state, the last
 * token-endpoint response, and the current time, it decides whether to keep
 * waiting (and for how long, honoring RFC 8628 §3.5 `slow_down` backoff) or
 * stop — it never performs I/O itself, so every branch (pending, slow_down
 * accumulation, expiry, denial, local timeout) is a plain data-in/data-out
 * assertion with no fake server required.
 *
 * `DeviceLoginResult`'s `success` case deliberately carries only `identity`
 * and the server's granted `scope`, never the access/refresh tokens — same
 * discipline as `LoopbackLoginResult`.
 */
import type { CredentialStore } from '../credentials/store.js';
import { DEFAULT_PROFILE_NAME } from '../credentials/serialize.js';
import type { ConfirmIdentity, DiscoverMetadata, DiscoveredMetadata, ExchangedTokens, Identity, WaitMs } from './loopback-flow.js';

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}
export type RequestDeviceAuthorization = (params: {
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly scope: string;
}) => Promise<DeviceAuthorization>;

/** RFC 8628 §3.5 poll outcomes, each a distinct variant — never an error string to parse. */
export type DeviceTokenResult =
  | { readonly kind: 'success'; readonly tokens: ExchangedTokens }
  | { readonly kind: 'authorization_pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'access_denied' }
  | { readonly kind: 'expired_token' }
  | { readonly kind: 'request_failed'; readonly message: string };

export type PollDeviceToken = (params: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly deviceCode: string;
}) => Promise<DeviceTokenResult>;

export interface DevicePollState {
  readonly intervalMs: number;
  /** Local watchdog deadline (epoch ms) — independent of the server's own `expired_token` response. */
  readonly deadline: number;
}

export type DeviceLoginOutcome =
  | { readonly kind: 'success'; readonly tokens: ExchangedTokens }
  | { readonly kind: 'access_denied' }
  | { readonly kind: 'expired_token' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'poll_failed'; readonly message: string };

export type NextPollDecision =
  | { readonly action: 'continue'; readonly waitMs: number; readonly nextState: DevicePollState }
  | { readonly action: 'stop'; readonly outcome: DeviceLoginOutcome };

const SLOW_DOWN_INCREMENT_MS = 5000;

/**
 * Decide what to do after a single device-code poll response.
 *
 * Precedence:
 *  1. Local timeout — `now >= state.deadline` wins over any response, so a
 *     stray late `authorization_pending` after the client has given up never
 *     restarts the wait.
 *  2. Terminal server responses (`success`, `access_denied`, `expired_token`,
 *     `request_failed`) stop immediately.
 *  3. `slow_down` — RFC 8628 §3.5: add 5 seconds to the interval and keep
 *     that wider interval for every subsequent poll (cumulative, not reset).
 *  4. `authorization_pending` — keep waiting at the current interval.
 */
export function decideNextPoll(state: DevicePollState, response: DeviceTokenResult, now: number): NextPollDecision {
  if (now >= state.deadline) {
    return { action: 'stop', outcome: { kind: 'timeout' } };
  }

  switch (response.kind) {
    case 'success':
      return { action: 'stop', outcome: { kind: 'success', tokens: response.tokens } };
    case 'access_denied':
      return { action: 'stop', outcome: { kind: 'access_denied' } };
    case 'expired_token':
      return { action: 'stop', outcome: { kind: 'expired_token' } };
    case 'request_failed':
      return { action: 'stop', outcome: { kind: 'poll_failed', message: response.message } };
    case 'slow_down': {
      const intervalMs = state.intervalMs + SLOW_DOWN_INCREMENT_MS;
      const nextState: DevicePollState = { intervalMs, deadline: state.deadline };
      return { action: 'continue', waitMs: intervalMs, nextState };
    }
    case 'authorization_pending':
      return { action: 'continue', waitMs: state.intervalMs, nextState: state };
    default: {
      const unreachable: never = response;
      throw new Error(`Unhandled device token response: ${JSON.stringify(unreachable)}`);
    }
  }
}

export interface DeviceLoginDeps {
  readonly host: string;
  readonly clientId: string;
  /** Space-delimited scope string (RFC 6749 §3.3). */
  readonly scope: string;
  readonly discoverMetadata: DiscoverMetadata;
  readonly requestDeviceAuthorization: RequestDeviceAuthorization;
  readonly pollDeviceToken: PollDeviceToken;
  readonly waitMs: WaitMs;
  readonly now: () => number;
  /** Called once with the verification details, before polling begins — the caller prints them. */
  readonly onDeviceCode: (authorization: DeviceAuthorization) => void;
  /** Overrides the server-declared `expires_in` as the local watchdog deadline; mainly for tests. */
  readonly timeoutMs?: number;
  readonly credentialStore: Pick<CredentialStore, 'set'>;
  readonly confirmIdentity: ConfirmIdentity;
  /** Polled between waits/polls; true once the user has hit Ctrl-C. Never an event emitter — keeps this module I/O-free. */
  readonly isInterrupted: () => boolean;
  /** Which named profile to store the credential under. Defaults to `"default"`, mirroring `loopback-flow.ts`. */
  readonly profile?: string;
  /**
   * Opt-in escape hatch for the "tokens never leave this function" rule,
   * mirroring `loopback-flow.ts`'s hook of the same name: invoked
   * synchronously with the raw `mcp_*` token immediately after persistence,
   * ONLY when the redemption minted a static (`kind: 'mcp'`) token — never
   * for the oauth pair, so `login --device` cannot surface a secret even if
   * it wired this. Callers must capture-and-defer, never print inside the
   * callback.
   */
  readonly onMintedStaticToken?: (token: string) => void;
}

export type DeviceLoginResult =
  | {
      readonly outcome: 'success';
      readonly identity: Identity | null;
      readonly scope: string;
      /** Set only for an `mcp_update` redemption — which existing key was re-scoped in place (no credential was stored). */
      readonly updatedTokenId?: string;
      /** Set only for an `mcp_activate` redemption — which existing key the human approved activating (nothing was stored). */
      readonly activatedTokenId?: string;
    }
  | { readonly outcome: 'access_denied' }
  | { readonly outcome: 'expired_token' }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'poll_failed'; readonly message: string }
  | { readonly outcome: 'interrupted' }
  | { readonly outcome: 'discovery_failed'; readonly message: string }
  | { readonly outcome: 'device_authorization_failed'; readonly message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDeviceLogin(deps: DeviceLoginDeps): Promise<DeviceLoginResult> {
  let metadata: DiscoveredMetadata;
  try {
    metadata = await deps.discoverMetadata(deps.host);
  } catch (error) {
    return { outcome: 'discovery_failed', message: messageOf(error) };
  }

  if (!metadata.deviceAuthorizationEndpoint) {
    return { outcome: 'discovery_failed', message: 'Server does not advertise a device_authorization_endpoint.' };
  }

  let authorization: DeviceAuthorization;
  try {
    authorization = await deps.requestDeviceAuthorization({
      deviceAuthorizationEndpoint: metadata.deviceAuthorizationEndpoint,
      clientId: deps.clientId,
      scope: deps.scope,
    });
  } catch (error) {
    return { outcome: 'device_authorization_failed', message: messageOf(error) };
  }

  deps.onDeviceCode(authorization);

  const deadline = deps.now() + (deps.timeoutMs ?? authorization.expiresInSeconds * 1000);
  let state: DevicePollState = { intervalMs: authorization.intervalSeconds * 1000, deadline };

  while (true) {
    if (deps.isInterrupted()) {
      return { outcome: 'interrupted' };
    }

    await deps.waitMs(state.intervalMs);

    if (deps.isInterrupted()) {
      return { outcome: 'interrupted' };
    }

    const response = await deps.pollDeviceToken({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId: deps.clientId,
      deviceCode: authorization.deviceCode,
    });

    const decision = decideNextPoll(state, response, deps.now());

    if (decision.action === 'continue') {
      state = decision.nextState;
      continue;
    }

    switch (decision.outcome.kind) {
      case 'success': {
        const { tokens } = decision.outcome;

        // An mcp_update redemption re-scoped an EXISTING key in place: the
        // server returned no secret, the locally stored credential (if any) is
        // unchanged, and there is no bearer in hand for confirmIdentity — so
        // nothing is persisted and no identity call is made. Mirrors
        // `runLoopbackLogin`.
        if (tokens.kind === 'mcp_update') {
          return { outcome: 'success', identity: null, scope: tokens.scope, updatedTokenId: tokens.tokenId };
        }

        // An mcp_activate redemption approved a device activation ceremony:
        // the server verified ownership and changed nothing. Same
        // persist-nothing posture as mcp_update — the caller records the
        // activation locally.
        if (tokens.kind === 'mcp_activate') {
          return { outcome: 'success', identity: null, scope: tokens.scope, activatedTokenId: tokens.tokenId };
        }

        // Flow-level invariant: only a request that actually ASKED for a mint
        // may persist one. A mint-shaped grant always carries a `name:` token
        // (the device authorization endpoint refuses a nameless mint outright),
        // so its absence means this flow requested something else — an
        // update/activate ceremony, or a plain `login --device`. A compromised
        // or older server answering any of those with a real mint would
        // otherwise leave a live secret in the keychain, stored under whatever
        // profile the caller passed, that the user was never told exists —
        // while the caller cheerfully reports the ceremony it asked for.
        //
        // Stricter than `runLoopbackLogin`'s equivalent guard, which only
        // covers the update/activate case: this preserves the protection the
        // device flow had when it rejected every non-oauth token outright,
        // now that it legitimately accepts mints for `keys create --device`.
        if (tokens.kind === 'mcp' && !deps.scope.split(' ').some((token) => token.startsWith('name:'))) {
          return {
            outcome: 'poll_failed',
            message: 'The server minted a new credential for a request that did not ask for one; nothing was stored.',
          };
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
          try {
            deps.onMintedStaticToken?.(tokens.token);
          } catch {
            // Best-effort surfacing hook (same fail-soft posture as
            // confirmIdentity below): the credential is already persisted, so
            // a buggy callback must not turn a successful mint into a failure.
          }
        }

        // Only an oauth grant has an identity to confirm. `/api/auth/me`
        // deliberately refuses `mcp_*` tokens (a scoped key is its own
        // principal — see `auth/probe-drives.ts`), so asking on behalf of a
        // freshly minted key could only 401: a guaranteed-doomed round trip,
        // billed at the confirm-identity timeout, on every `keys create
        // --device`. `whoami` gates the same call the same way.
        let identity: Identity | null = null;
        if (tokens.kind === 'oauth') {
          try {
            identity = await deps.confirmIdentity({ host: deps.host, accessToken: tokens.accessToken });
          } catch {
            identity = null;
          }
        }

        return { outcome: 'success', identity, scope: tokens.scope };
      }
      case 'access_denied':
        return { outcome: 'access_denied' };
      case 'expired_token':
        return { outcome: 'expired_token' };
      case 'timeout':
        return { outcome: 'timeout' };
      case 'poll_failed':
        return { outcome: 'poll_failed', message: decision.outcome.message };
      default: {
        const unreachable: never = decision.outcome;
        throw new Error(`Unhandled device login outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}
