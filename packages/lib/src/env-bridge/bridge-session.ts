/**
 * The daemon's connection lifecycle as a pure reducer (invariants 6 and 8).
 *
 *   disconnected → connecting → hello_sent → authorized
 *                                        ↘ (disconnect) → disconnected
 *   any state ── revoke_verified ──▶ revoked  (terminal; emits deleteKey)
 *
 * Effects are DATA (`send`, `dispatch`, `reject`, `deleteKey`,
 * `schedule_reconnect`) and are never performed here; the adapter performs
 * them. That is what makes every transition testable in isolation and keeps
 * the security-relevant rules in one place:
 *
 * - An inbound frame is `dispatch`ed to the executor ONLY in `authorized`. In
 *   every other state it is `reject`ed and nothing runs (invariant 6).
 * - A `revoke` FRAME is not honoured here — it is dispatched like any frame so
 *   the adapter can verify its signature; only the adapter's `revoke_verified`
 *   EVENT moves the machine to `revoked`, which emits `deleteKey` (the daemon
 *   destroys its own identity) and is terminal (invariant 8).
 * - `disconnect` never deletes the key; it schedules a reconnect. Losing the
 *   socket is not a revocation.
 *
 * No clock, no randomness: `ping` is dispatched so the adapter can answer
 * with a timestamp the reducer does not have.
 */
import type { Frame } from './frame-codec';

export type BridgeStatus = 'disconnected' | 'connecting' | 'hello_sent' | 'authorized' | 'revoked';

export interface BridgeSessionState {
  readonly status: BridgeStatus;
}

export type BridgeEvent =
  | { readonly type: 'connect' }
  | { readonly type: 'socket_open'; readonly hello: Frame }
  | { readonly type: 'hello_ack' }
  | { readonly type: 'frame'; readonly frame: Frame }
  | { readonly type: 'revoke_verified' }
  | { readonly type: 'disconnect' };

export type BridgeRejectReason = 'not_authorized' | 'revoked' | 'unexpected_hello_ack' | 'unexpected_socket_open' | 'already_connected';

export type BridgeEffect =
  | { readonly type: 'send'; readonly frame: Frame }
  | { readonly type: 'dispatch'; readonly frame: Frame }
  | { readonly type: 'reject'; readonly reason: BridgeRejectReason }
  | { readonly type: 'deleteKey' }
  | { readonly type: 'schedule_reconnect' };

export interface BridgeReduction {
  readonly state: BridgeSessionState;
  readonly effects: readonly BridgeEffect[];
}

export function initialBridgeSession(): BridgeSessionState {
  return { status: 'disconnected' };
}

function stay(state: BridgeSessionState, ...effects: BridgeEffect[]): BridgeReduction {
  return { state, effects };
}

function go(status: BridgeStatus, ...effects: BridgeEffect[]): BridgeReduction {
  return { state: { status }, effects };
}

/**
 * Reduce one event against the current state.
 * @returns the next state and the effects the adapter must perform, as data.
 */
export function reduceBridgeSession(state: BridgeSessionState, event: BridgeEvent): BridgeReduction {
  // Revocation wins from every state, and revoked is terminal.
  if (event.type === 'revoke_verified') return go('revoked', { type: 'deleteKey' });
  if (state.status === 'revoked') return stay(state, { type: 'reject', reason: 'revoked' });

  switch (event.type) {
    case 'connect':
      return state.status === 'disconnected' ? go('connecting') : stay(state, { type: 'reject', reason: 'already_connected' });
    case 'socket_open':
      return state.status === 'connecting' ? go('hello_sent', { type: 'send', frame: event.hello }) : stay(state, { type: 'reject', reason: 'unexpected_socket_open' });
    case 'hello_ack':
      return state.status === 'hello_sent' ? go('authorized') : stay(state, { type: 'reject', reason: 'unexpected_hello_ack' });
    case 'frame':
      return state.status === 'authorized' ? stay(state, { type: 'dispatch', frame: event.frame }) : stay(state, { type: 'reject', reason: 'not_authorized' });
    case 'disconnect':
      return state.status === 'disconnected' ? stay(state) : go('disconnected', { type: 'schedule_reconnect' });
  }
}
