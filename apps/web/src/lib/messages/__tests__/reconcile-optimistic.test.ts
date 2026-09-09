/**
 * The reported bug — photos rendering twice until refresh — was ultimately a
 * reconcile bug, and it survived because the channel and DM surfaces each had
 * their own copy of this logic. These pin the behaviour of the single copy.
 */
import { describe, it, expect } from 'vitest';
import { reconcileOptimistic } from '../reconcile-optimistic';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const pending = (nonce: string) => ({ id: `temp-${nonce}`, clientNonce: nonce });
const confirmed = (id: string, nonce?: string) => ({ id, clientNonce: nonce });

describe('reconcileOptimistic', () => {
  it('retires exactly one pending row per confirmation', () => {
    const prev = [pending('a'), pending('b'), pending('c')];

    const next = reconcileOptimistic(prev, confirmed('server-b', 'b'));

    assert({
      given: 'three sends in flight and the second confirming',
      should: 'replace only that one — dropping all pending rows is what made a batch flicker',
      actual: next.map((m) => m.id),
      expected: ['temp-a', 'server-b', 'temp-c'],
    });
  });

  it('keeps the confirmed message where the pending row sat', () => {
    const prev = [confirmed('older'), pending('a'), confirmed('newer')];

    const next = reconcileOptimistic(prev, confirmed('server-a', 'a'));

    assert({
      given: 'a pending row with messages either side of it',
      should: 'replace in place rather than moving the message to the end',
      actual: next.map((m) => m.id),
      expected: ['older', 'server-a', 'newer'],
    });
  });

  it('appends a message from another sender', () => {
    const prev = [confirmed('existing')];

    const next = reconcileOptimistic(prev, confirmed('from-someone-else'));

    assert({
      given: 'a broadcast carrying no nonce this client minted',
      should: 'append it — every other viewer in the channel takes this path',
      actual: next.map((m) => m.id),
      expected: ['existing', 'from-someone-else'],
    });
  });

  it('ignores a re-delivered message', () => {
    const prev = [confirmed('a'), confirmed('b')];

    const next = reconcileOptimistic(prev, confirmed('b'));

    assert({
      given: 'a socket event delivered twice',
      should: 'return the list untouched rather than duplicating the row',
      actual: next.map((m) => m.id),
      expected: ['a', 'b'],
    });
  });

  it('drops a duplicate that arrived by another route while a send was pending', () => {
    // The POST response and the socket echo both reconcile, so the same
    // message can arrive twice — once against the pending row, once after it
    // has already been inserted.
    const prev = [pending('a'), confirmed('server-a', 'a')];

    const next = reconcileOptimistic(prev, confirmed('server-a', 'a'));

    assert({
      given: 'a confirmation racing a copy that already landed',
      should: 'end with exactly one copy',
      actual: next.map((m) => m.id),
      expected: ['server-a'],
    });
  });

  it('never matches a pending row against a nonce-less message', () => {
    const prev = [pending('a')];

    const next = reconcileOptimistic(prev, confirmed('server-x'));

    assert({
      given: 'someone else sending while this client has a send in flight',
      should: 'leave the pending row alone and append',
      actual: next.map((m) => m.id),
      expected: ['temp-a', 'server-x'],
    });
  });

  it('never matches an already-confirmed row, even on a nonce it still carries', () => {
    // The replaced row keeps the echoed nonce, so matching must also require
    // the row to still be pending.
    const prev = [confirmed('server-a', 'a')];

    const next = reconcileOptimistic(prev, confirmed('server-b', 'a'));

    assert({
      given: 'a second message echoing a nonce a settled row still carries',
      should: 'append rather than overwrite the settled message',
      actual: next.map((m) => m.id),
      expected: ['server-a', 'server-b'],
    });
  });
});
