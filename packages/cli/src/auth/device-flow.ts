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
 * `DeviceLoginResult`'s `success` case deliberately carries only `identity`,
 * never the access/refresh tokens — same discipline as `LoopbackLoginResult`.
 */
import type { CredentialStore } from '../credentials/store.js';
import type { ConfirmIdentity, DiscoverMetadata, ExchangedTokens, Identity, WaitMs } from './loopback-flow.js';

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
export function decideNextPoll(_state: DevicePollState, _response: DeviceTokenResult, _now: number): NextPollDecision {
  throw new Error('not implemented');
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
}

export type DeviceLoginResult =
  | { readonly outcome: 'success'; readonly identity: Identity | null }
  | { readonly outcome: 'access_denied' }
  | { readonly outcome: 'expired_token' }
  | { readonly outcome: 'timeout' }
  | { readonly outcome: 'poll_failed'; readonly message: string }
  | { readonly outcome: 'interrupted' }
  | { readonly outcome: 'discovery_failed'; readonly message: string }
  | { readonly outcome: 'device_authorization_failed'; readonly message: string };

export async function runDeviceLogin(_deps: DeviceLoginDeps): Promise<DeviceLoginResult> {
  throw new Error('not implemented');
}
