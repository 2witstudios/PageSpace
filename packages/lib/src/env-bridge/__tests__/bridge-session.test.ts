import { describe, it, expect } from 'vitest';
import { reduceBridgeSession, initialBridgeSession, type BridgeSessionState, type BridgeEvent } from '../bridge-session';
import type { Frame } from '../frame-codec';

const HELLO: Frame = { type: 'hello', envId: 'e1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: 'd', sig: 'AAAA' };
const GRANT_EXEC: Frame = { type: 'grant_exec', grant: { grantId: 'g1' }, sig: 'AAAA', cmd: 'ls', args: [] };
const PING: Frame = { type: 'ping', ts: 1 };

const at = (status: BridgeSessionState['status']): BridgeSessionState => ({ status });
const ALL: BridgeSessionState['status'][] = ['disconnected', 'connecting', 'hello_sent', 'authorized', 'revoked'];

describe('reduceBridgeSession — the daemon connection lifecycle as a pure reducer (invariants 6, 8)', () => {
  it('starts disconnected', () => {
    expect(initialBridgeSession()).toEqual({ status: 'disconnected' });
  });

  it('disconnected + connect → connecting, no effects', () => {
    expect(reduceBridgeSession(at('disconnected'), { type: 'connect' })).toEqual({ state: at('connecting'), effects: [] });
  });

  it('connecting + socket_open(hello) → hello_sent and emits send(hello)', () => {
    expect(reduceBridgeSession(at('connecting'), { type: 'socket_open', hello: HELLO })).toEqual({ state: at('hello_sent'), effects: [{ type: 'send', frame: HELLO }] });
  });

  it('hello_sent + hello_ack → authorized', () => {
    expect(reduceBridgeSession(at('hello_sent'), { type: 'hello_ack' })).toEqual({ state: at('authorized'), effects: [] });
  });

  it.each(ALL.filter((s) => s !== 'hello_sent'))('%s + hello_ack → reject(unexpected_hello_ack), state unchanged', (status) => {
    const before = at(status);
    const out = reduceBridgeSession(before, { type: 'hello_ack' });
    expect(out.state).toEqual(before);
    expect(out.effects).toEqual([{ type: 'reject', reason: status === 'revoked' ? 'revoked' : 'unexpected_hello_ack' }]);
  });

  it('authorized + inbound grant frame → dispatch(frame), state unchanged', () => {
    expect(reduceBridgeSession(at('authorized'), { type: 'frame', frame: GRANT_EXEC })).toEqual({ state: at('authorized'), effects: [{ type: 'dispatch', frame: GRANT_EXEC }] });
  });

  it('authorized + ping → dispatch (the adapter answers with a clock the reducer does not have)', () => {
    expect(reduceBridgeSession(at('authorized'), { type: 'frame', frame: PING })).toEqual({ state: at('authorized'), effects: [{ type: 'dispatch', frame: PING }] });
  });

  it.each(ALL.filter((s) => s !== 'authorized'))('%s + inbound grant frame → reject(not_authorized|revoked) and NOTHING is dispatched', (status) => {
    const out = reduceBridgeSession(at(status), { type: 'frame', frame: GRANT_EXEC });
    expect(out.state).toEqual(at(status));
    expect(out.effects.some((e) => e.type === 'dispatch')).toBe(false);
    expect(out.effects).toEqual([{ type: 'reject', reason: status === 'revoked' ? 'revoked' : 'not_authorized' }]);
  });

  it.each(ALL)('%s + revoke_verified → revoked and emits deleteKey (invariant 8: the daemon deletes its key)', (status) => {
    expect(reduceBridgeSession(at(status), { type: 'revoke_verified' })).toEqual({ state: at('revoked'), effects: [{ type: 'deleteKey' }] });
  });

  it('a revoke frame arriving as an ordinary inbound frame is NOT honoured by the reducer — only the adapter-verified revoke_verified event is (signature checked first)', () => {
    const revoke: Frame = { type: 'revoke', sig: 'AAAA', issuedAt: 1 };
    const out = reduceBridgeSession(at('authorized'), { type: 'frame', frame: revoke });
    expect(out.state).toEqual(at('authorized'));
    expect(out.effects).toEqual([{ type: 'dispatch', frame: revoke }]);
  });

  it.each(['connecting', 'hello_sent', 'authorized'] as const)('%s + disconnect → disconnected with schedule_reconnect and NO deleteKey', (status) => {
    const out = reduceBridgeSession(at(status), { type: 'disconnect' });
    expect(out).toEqual({ state: at('disconnected'), effects: [{ type: 'schedule_reconnect' }] });
    expect(out.effects.some((e) => e.type === 'deleteKey')).toBe(false);
  });

  it('disconnected + disconnect → no-op', () => {
    expect(reduceBridgeSession(at('disconnected'), { type: 'disconnect' })).toEqual({ state: at('disconnected'), effects: [] });
  });

  it('revoked is terminal: connect / disconnect / socket_open / frames all reject(revoked) and never leave revoked', () => {
    const events: BridgeEvent[] = [{ type: 'connect' }, { type: 'disconnect' }, { type: 'socket_open', hello: HELLO }, { type: 'frame', frame: GRANT_EXEC }, { type: 'hello_ack' }];
    for (const event of events) {
      const out = reduceBridgeSession(at('revoked'), event);
      expect(out.state, event.type).toEqual(at('revoked'));
      expect(out.effects, event.type).toEqual([{ type: 'reject', reason: 'revoked' }]);
    }
  });

  it.each(['connecting', 'hello_sent', 'authorized'] as const)('%s + connect → reject(already_connected), state unchanged', (status) => {
    expect(reduceBridgeSession(at(status), { type: 'connect' })).toEqual({ state: at(status), effects: [{ type: 'reject', reason: 'already_connected' }] });
  });

  it.each(['disconnected', 'hello_sent', 'authorized'] as const)('%s + socket_open → reject(unexpected_socket_open), no hello sent', (status) => {
    const out = reduceBridgeSession(at(status), { type: 'socket_open', hello: HELLO });
    expect(out.state).toEqual(at(status));
    expect(out.effects).toEqual([{ type: 'reject', reason: 'unexpected_socket_open' }]);
  });

  it('is pure: same (state, event) → deep-equal output, input state not mutated, effects are plain data', () => {
    const state = at('authorized');
    const frozen = Object.freeze({ ...state });
    const a = reduceBridgeSession(frozen, { type: 'frame', frame: GRANT_EXEC });
    const b = reduceBridgeSession(frozen, { type: 'frame', frame: GRANT_EXEC });
    expect(a).toEqual(b);
    expect(frozen).toEqual(at('authorized'));
    for (const e of a.effects) expect(typeof e.type).toBe('string');
  });

  it('walks the happy path end to end: disconnected → connecting → hello_sent → authorized → (dispatch) → disconnected → revoked', () => {
    let s = initialBridgeSession();
    const step = (e: BridgeEvent) => { const out = reduceBridgeSession(s, e); s = out.state; return out.effects; };
    expect(step({ type: 'connect' })).toEqual([]);
    expect(step({ type: 'socket_open', hello: HELLO })).toEqual([{ type: 'send', frame: HELLO }]);
    expect(step({ type: 'hello_ack' })).toEqual([]);
    expect(step({ type: 'frame', frame: GRANT_EXEC })).toEqual([{ type: 'dispatch', frame: GRANT_EXEC }]);
    expect(step({ type: 'disconnect' })).toEqual([{ type: 'schedule_reconnect' }]);
    expect(step({ type: 'revoke_verified' })).toEqual([{ type: 'deleteKey' }]);
    expect(s).toEqual(at('revoked'));
  });
});
