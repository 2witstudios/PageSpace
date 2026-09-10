/**
 * The reported bug — photos rendering twice until refresh — was ultimately a
 * reconcile bug, and it survived because the channel and DM surfaces each had
 * their own copy of this logic. These pin the behaviour of the single copy.
 */
import { describe, it, expect } from 'vitest';
import { reconcileOptimistic, sameAttachmentBatch } from '../reconcile-optimistic';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

/** The rows the fallback tests below work with: a nonce is OPTIONAL on them,
 *  because the whole point is a confirmation that arrives without one. */
interface Row {
  id: string;
  clientNonce?: string;
  userId: string;
  content: string;
}

const pending = (nonce: string) => ({ id: `temp-${nonce}`, clientNonce: nonce });
const confirmed = (id: string, nonce?: string) => ({ id, clientNonce: nonce });

describe('sameAttachmentBatch', () => {
  const batch = (...fileIds: string[]) =>
    fileIds.map((fileId, position) => ({ fileId, position }));

  it('matches two rows naming the same files in the same order', () => {
    assert({
      given: 'the same three photos, one side handed back out of order',
      should: 'match on position, not on arrival order',
      actual: sameAttachmentBatch(
        { attachments: batch('f-1', 'f-2', 'f-3') },
        { attachments: [{ fileId: 'f-3', position: 2 }, { fileId: 'f-1', position: 0 }, { fileId: 'f-2', position: 1 }] },
      ),
      expected: true,
    });
  });

  it('separates two sends that share a first photo but differ after it', () => {
    // The case the first-file comparison could not see: matching these would
    // retire the wrong pending row and leave the stream mis-ordered.
    assert({
      given: 'two batches starting with the same photo',
      should: 'not treat them as the same send',
      actual: sameAttachmentBatch(
        { attachments: batch('f-1', 'f-2') },
        { attachments: batch('f-1', 'f-9') },
      ),
      expected: false,
    });
  });

  it('never matches a multi-file pending row against a payload that names no batch', () => {
    // A server old enough to omit the nonce reads only `fileId`, so it rejects
    // a multi-attachment send outright rather than echoing one. Declining to
    // guess here costs nothing and cannot retire the wrong row.
    assert({
      given: 'a two-photo send pending and a legacy-shaped confirmation',
      should: 'decline the match rather than guess from the first file',
      actual: sameAttachmentBatch(
        { fileId: 'f-1', attachments: batch('f-1', 'f-2') },
        { fileId: 'f-1' },
      ),
      expected: false,
    });
  });

  it('still matches the single-attachment legacy shape', () => {
    assert({
      given: 'one file on each side, named only by the legacy column',
      should: 'match — this is the shape an old pod actually echoes',
      actual: sameAttachmentBatch({ fileId: 'f-1' }, { fileId: 'f-1' }),
      expected: true,
    });
  });

  it('matches two text-only sends', () => {
    assert({
      given: 'no attachment on either side',
      should: 'match on the absence, leaving content to separate them',
      actual: sameAttachmentBatch({}, {}),
      expected: true,
    });
  });
});

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

  it('never lets another sender claim a pending row by reusing its nonce', () => {
    // The nonce rides the broadcast to every subscriber, and the API takes
    // whatever nonce a caller sends. Without the author check, this message
    // would replace the sender's own pending row and their message would
    // vanish from their view until a refetch.
    const prev = [{ id: 'temp-a', clientNonce: 'a', userId: 'me' }];

    const next = reconcileOptimistic(
      prev,
      { id: 'server-imposter', clientNonce: 'a', userId: 'someone-else' },
      (m) => m.userId,
    );

    assert({
      given: 'a message from another user echoing a nonce this client minted',
      should: 'append it and leave the pending row in flight',
      actual: next.map((m) => m.id),
      expected: ['temp-a', 'server-imposter'],
    });
  });

  it('still retires the pending row for the sender\'s own echo', () => {
    const prev = [{ id: 'temp-a', clientNonce: 'a', userId: 'me' }];

    const next = reconcileOptimistic(
      prev,
      { id: 'server-a', clientNonce: 'a', userId: 'me' },
      (m) => m.userId,
    );

    assert({
      given: 'the confirmation of this client\'s own send',
      should: 'replace the pending row — the author check must not block the normal path',
      actual: next.map((m) => m.id),
      expected: ['server-a'],
    });
  });

  it('retires the pending row for a nonce-less echo from the same sender', () => {
    // What a pod that predates the nonce broadcasts — reachable during a
    // rolling deploy, where a new client posts to an old server. Without this
    // fallback the sender sees their own message twice until a refetch, which
    // is the exact complaint this change exists to answer.
    const prev: Row[] = [{ id: 'temp-a', clientNonce: 'a', userId: 'me', content: 'hi' }];

    const next = reconcileOptimistic<Row>(
      prev,
      { id: 'server-a', userId: 'me', content: 'hi' },
      (m) => m.userId,
      (pending, confirmed) => pending.content === confirmed.content,
    );

    assert({
      given: 'an echo of this client\'s own send that carries no nonce',
      should: 'retire the pending row rather than append a duplicate',
      actual: next.map((m) => m.id),
      expected: ['server-a'],
    });
  });

  it('never lets the nonce-less fallback match another sender', () => {
    const prev: Row[] = [{ id: 'temp-a', clientNonce: 'a', userId: 'me', content: 'hi' }];

    const next = reconcileOptimistic<Row>(
      prev,
      { id: 'server-theirs', userId: 'someone-else', content: 'hi' },
      (m) => m.userId,
      (pending, confirmed) => pending.content === confirmed.content,
    );

    assert({
      given: 'someone else posting the same text while a send is in flight',
      should: 'append it — identical content is not identity',
      actual: next.map((m) => m.id),
      expected: ['temp-a', 'server-theirs'],
    });
  });

  it('prefers the nonce over the fallback when both could match', () => {
    const prev: Row[] = [
      { id: 'temp-a', clientNonce: 'a', userId: 'me', content: 'hi' },
      { id: 'temp-b', clientNonce: 'b', userId: 'me', content: 'hi' },
    ];

    const next = reconcileOptimistic<Row>(
      prev,
      { id: 'server-b', clientNonce: 'b', userId: 'me', content: 'hi' },
      (m) => m.userId,
      (pending, confirmed) => pending.content === confirmed.content,
    );

    assert({
      given: 'two identical sends in flight and a nonce naming the second',
      should: 'retire the one the nonce names, not the first that looks alike',
      actual: next.map((m) => m.id),
      expected: ['temp-a', 'server-b'],
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
