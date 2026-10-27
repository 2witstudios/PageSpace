/**
 * ONE UNMOUNT MUST NOT EVICT THE WHOLE TAB (review finding — MAJOR 1).
 *
 * `conv:<id>` membership is per-SOCKET and a tab has one socket, so the
 * unconditional `leave_conversation` the subscription hook used to emit on
 * unmount dropped the room for every OTHER subscription in the tab watching
 * the same conversation. Two subscriptions on one id is the documented
 * expected shape — `GlobalChatContext` watches the current conversation
 * app-wide while a pane watches the same one — so closing the pane starved the
 * provider. Nothing errored: the rev-gated protocol just stopped advancing the
 * survivor's watermark, which is the epic's own canonical bug arriving through
 * its own subscription primitive.
 *
 * WHERE THE COVERAGE ACTUALLY LIVES, because it is not where a reader would
 * assume. The closest E2E user story — "two windows on one conversation both
 * see both sides of a dispatched turn live"
 * (`apps/e2e/tests/16-dispatch-multiplayer.spec.ts`) — opens two browser
 * CONTEXTS, so it is two sockets and two module scopes with independent
 * counts. It cannot see this bug and could never have caught it: the failure
 * needs two subscribers sharing ONE socket, which is the single-tab case.
 *
 * So this suite plus the two tests in `useConversationSubscription`'s own
 * suite are the whole of it — this one for the refcount, those for the hook
 * driving it, since either can regress without the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  acquireConversationRoom,
  releaseConversationRoom,
  heldConversationRooms,
  resetConversationRooms,
} from '../conversation-room-membership';

const CONV = 'conv_shared';

function makeSocket() {
  return { emit: vi.fn() };
}

const emitted = (socket: { emit: ReturnType<typeof vi.fn> }, event: string) =>
  socket.emit.mock.calls.filter(([e]) => e === event).map(([, payload]) => payload);

beforeEach(() => {
  resetConversationRooms();
});

describe('conversation room membership', () => {
  it('leaves only when the LAST subscription on a conversation goes', () => {
    const socket = makeSocket();

    // The provider and a pane, both watching the same conversation.
    acquireConversationRoom(socket, CONV);
    acquireConversationRoom(socket, CONV);

    // The pane closes.
    releaseConversationRoom(socket, CONV);

    // THE FINDING: this used to be a `leave_conversation`, and the provider —
    // still mounted, still rendering this conversation — went deaf.
    expect(emitted(socket, 'leave_conversation')).toEqual([]);
    expect(heldConversationRooms()).toEqual([CONV]);

    // The provider unmounts too: now nobody is watching, so the room goes.
    releaseConversationRoom(socket, CONV);
    expect(emitted(socket, 'leave_conversation')).toEqual([CONV]);
    expect(heldConversationRooms()).toEqual([]);
  });

  it('joins on EVERY acquire, not only the first — a duplicate join is idempotent, and a socket swap has to re-join', () => {
    const socket = makeSocket();

    acquireConversationRoom(socket, CONV);
    acquireConversationRoom(socket, CONV);

    // Gating the join on 0→1 would be the subtly wrong shape: the counter is
    // keyed on conversation id alone, so when the socket is replaced the count
    // can stay above zero across the swap and the NEW socket would join
    // nothing. The server re-authorizes each join and `socket.join` on a room
    // already joined is a no-op, so the cost of always emitting is a check.
    expect(emitted(socket, 'join_conversation')).toEqual([CONV, CONV]);
  });

  it('survives a socket swap while a second subscription holds the room', () => {
    const oldSocket = makeSocket();
    const newSocket = makeSocket();

    // Provider and pane, on the old socket.
    acquireConversationRoom(oldSocket, CONV);
    acquireConversationRoom(oldSocket, CONV);

    // The pane's effect re-runs against the new socket: release then acquire.
    // The count never reaches zero, so no leave — and the join still lands on
    // the socket that now needs it.
    releaseConversationRoom(oldSocket, CONV);
    acquireConversationRoom(newSocket, CONV);

    expect(emitted(oldSocket, 'leave_conversation')).toEqual([]);
    expect(emitted(newSocket, 'join_conversation')).toEqual([CONV]);
  });

  it('keeps conversations independent — releasing one never touches another', () => {
    const socket = makeSocket();

    acquireConversationRoom(socket, 'conv_a');
    acquireConversationRoom(socket, 'conv_b');
    releaseConversationRoom(socket, 'conv_a');

    expect(emitted(socket, 'leave_conversation')).toEqual(['conv_a']);
    expect(heldConversationRooms()).toEqual(['conv_b']);
  });

  it('ignores a release with no matching acquire rather than emitting a stray leave', () => {
    const socket = makeSocket();

    // React can run a cleanup for an effect whose setup bailed early (no
    // socket yet, no conversation id). That must not evict a room this tab
    // may hold for another reason.
    releaseConversationRoom(socket, CONV);

    expect(socket.emit).not.toHaveBeenCalled();
    expect(heldConversationRooms()).toEqual([]);
  });
});
