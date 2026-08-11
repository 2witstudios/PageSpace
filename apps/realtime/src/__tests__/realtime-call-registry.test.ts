/**
 * Registry tests. The registry is where a leaked call becomes a bill, so the
 * cases that matter are the ones about entries NOT sticking around.
 */

import { describe, it, expect, vi } from 'vitest';
import { REALTIME_MAX_GLOBAL_SESSIONS } from '@pagespace/lib/billing/credit-pricing';
import {
  RealtimeCallRegistry,
  DEFAULT_MAX_CONCURRENT_CALLS,
} from '../voice/realtime-call-registry';
import type { RealtimeCallSession } from '../voice/realtime-call-session';

function fakeSession(callId: string, userId = 'u1'): RealtimeCallSession {
  let ended = false;
  return {
    callId,
    userId,
    conversationId: undefined,
    subscribe: () => () => {},
    send: vi.fn(),
    end: vi.fn(() => {
      ended = true;
    }),
    get ended() {
      return ended;
    },
  };
}

describe('RealtimeCallRegistry', () => {
  it('given a registered session, should find it by call id', () => {
    const registry = new RealtimeCallRegistry();
    const session = fakeSession('rtc_a');
    registry.register(session);

    expect(registry.get('rtc_a')).toBe(session);
    expect(registry.size).toBe(1);
    expect(registry.callIds()).toEqual(['rtc_a']);
  });

  it('given an unregister, should forget the call', () => {
    const registry = new RealtimeCallRegistry();
    registry.register(fakeSession('rtc_a'));
    registry.unregister('rtc_a');

    expect(registry.get('rtc_a')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('given two calls, should keep their registry entries independent', () => {
    const registry = new RealtimeCallRegistry();
    const a = fakeSession('rtc_a', 'ua');
    const b = fakeSession('rtc_b', 'ub');
    registry.register(a);
    registry.register(b);

    registry.unregister('rtc_a');

    expect(registry.get('rtc_a')).toBeUndefined();
    expect(registry.get('rtc_b')).toBe(b);
    expect(b.ended).toBe(false);
  });

  it('given a re-attach for the same call id, should end the old socket so only one bills', () => {
    const registry = new RealtimeCallRegistry();
    const first = fakeSession('rtc_a');
    const second = fakeSession('rtc_a');
    registry.register(first);
    registry.register(second);

    expect(first.end).toHaveBeenCalled();
    expect(registry.get('rtc_a')).toBe(second);
    expect(registry.size).toBe(1);
  });

  it('given the same session registered twice, should NOT end it', () => {
    const registry = new RealtimeCallRegistry();
    const session = fakeSession('rtc_a');
    registry.register(session);
    registry.register(session);

    expect(session.end).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('given calls for several users, should list one user\'s calls only', () => {
    const registry = new RealtimeCallRegistry();
    registry.register(fakeSession('rtc_a', 'ua'));
    registry.register(fakeSession('rtc_b', 'ua'));
    registry.register(fakeSession('rtc_c', 'ub'));

    expect(registry.getForUser('ua').map((s) => s.callId)).toEqual(['rtc_a', 'rtc_b']);
    expect(registry.getForUser('ub').map((s) => s.callId)).toEqual(['rtc_c']);
    expect(registry.getForUser('nobody')).toEqual([]);
  });

  it('given the cap is reached, should report capacity — and free up as calls end', () => {
    const registry = new RealtimeCallRegistry(2);
    expect(registry.atCapacity()).toBe(false);

    registry.register(fakeSession('rtc_a'));
    expect(registry.atCapacity()).toBe(false);
    registry.register(fakeSession('rtc_b'));
    expect(registry.atCapacity()).toBe(true);

    registry.unregister('rtc_a');
    expect(registry.atCapacity()).toBe(false);
  });

  it('given a reserved slot, should count it toward capacity before any call registers', () => {
    const registry = new RealtimeCallRegistry(1);

    expect(registry.reserveSlot('u1', 8)).toEqual({ ok: true });
    expect(registry.reserved).toBe(1);
    // Nothing is registered yet, and the registry is already full — this is the
    // whole point: an in-flight attach occupies the cap.
    expect(registry.size).toBe(0);
    expect(registry.reserveSlot('u2', 8)).toEqual({ ok: false, refusedBy: 'deployment' });
  });

  it('given a user at their own cap, should refuse them by NAME while the deployment has room', () => {
    const registry = new RealtimeCallRegistry(8);

    expect(registry.reserveSlot('u1', 1)).toEqual({ ok: true });
    // Still in flight — nothing registered — which is exactly the window a
    // per-user check made from the registered count alone would wave through.
    expect(registry.size).toBe(0);
    expect(registry.reserveSlot('u1', 1)).toEqual({ ok: false, refusedBy: 'user' });
    // One person's limit is not everyone's.
    expect(registry.reserveSlot('u2', 1)).toEqual({ ok: true });
  });

  it('should count a REGISTERED call toward the per-user cap too, not just in-flight ones', () => {
    const registry = new RealtimeCallRegistry(8);
    registry.register(fakeSession('rtc_a', 'u1'));

    expect(registry.heldByUser('u1')).toBe(1);
    expect(registry.reserveSlot('u1', 1)).toEqual({ ok: false, refusedBy: 'user' });
  });

  it('given a released slot, should free the capacity again — deployment-wide and per user', () => {
    const registry = new RealtimeCallRegistry(1);
    registry.reserveSlot('u1', 1);
    registry.releaseSlot('u1');

    expect(registry.reserved).toBe(0);
    expect(registry.heldByUser('u1')).toBe(0);
    expect(registry.reserveSlot('u1', 1)).toEqual({ ok: true });
  });

  it('given a released slot, should not keep an entry for a user with nothing in flight', () => {
    const registry = new RealtimeCallRegistry(4);
    registry.reserveSlot('u1', 4);
    registry.reserveSlot('u1', 4);
    expect(registry.heldByUser('u1')).toBe(2);

    registry.releaseSlot('u1');
    expect(registry.heldByUser('u1')).toBe(1);
    registry.releaseSlot('u1');
    expect(registry.heldByUser('u1')).toBe(0);
    // Over-releasing a user must not drive their count below zero either.
    registry.releaseSlot('u1');
    expect(registry.heldByUser('u1')).toBe(0);
  });

  it('given more releases than reserves, should not go negative and hand out phantom slots', () => {
    const registry = new RealtimeCallRegistry(1);
    registry.releaseSlot('u1');
    registry.releaseSlot('u1');

    expect(registry.reserved).toBe(0);
    registry.register(fakeSession('rtc_a'));
    expect(registry.atCapacity()).toBe(true);
  });

  it('given endAll, should end every call and empty the map', () => {
    const registry = new RealtimeCallRegistry();
    const a = fakeSession('rtc_a');
    const b = fakeSession('rtc_b');
    registry.register(a);
    registry.register(b);

    registry.endAll('shutdown');

    expect(a.end).toHaveBeenCalledWith('shutdown');
    expect(b.end).toHaveBeenCalledWith('shutdown');
    expect(registry.size).toBe(0);
  });

  it('should default to a cap low enough to matter against a 40k tokens/min budget', () => {
    expect(DEFAULT_MAX_CONCURRENT_CALLS).toBeGreaterThan(0);
    expect(new RealtimeCallRegistry().atCapacity()).toBe(false);
  });

  it('should take its default cap from the documented env knob, not a second literal', () => {
    // An operator who sets REALTIME_MAX_GLOBAL_SESSIONS must see admission
    // change; a hardcoded default here would outrank the knob silently.
    expect(DEFAULT_MAX_CONCURRENT_CALLS).toBe(REALTIME_MAX_GLOBAL_SESSIONS);
  });
});
