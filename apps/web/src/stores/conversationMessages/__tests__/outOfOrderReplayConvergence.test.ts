import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { replayPendingMutations } from '../replayPendingMutations';
import type { PendingMutation } from '../seedEmpty';

const msg = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

const textOf = (m: UIMessage): string =>
  m.parts.map((p) => ('text' in p ? p.text : '')).join('');

/**
 * PERMANENT-DIVERGENCE REGRESSION (found by the property-based convergence suite
 * at seed 37, minimised to three writes; Agent-Session SSoT epic, Phase 2).
 *
 * Conversation events are independent HMAC POSTs into realtime, which emits them
 * in RECEIVE order — so two near-simultaneous writes to one conversation can
 * reach a socket reversed. When the higher rev lands first it reads as a gap and
 * triggers a refetch; the lower rev then arrives while that refetch is still in
 * flight, is contiguous with the watermark, and is applied AND recorded as a
 * pending mutation. If that pending mutation is replayed over the fetched
 * snapshot, an OLDER payload lands on top of NEWER truth — and because the
 * watermark still folds forward to the snapshot's rev, the client reads as
 * current while showing stale content. `syncWatchedConversationRevs` compares
 * revs, not content, so nothing ever heals it: the divergence is permanent.
 */
describe('out-of-order delivery during a gap-heal refetch', () => {
  beforeEach(() => {
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  it('given update@3 delivered before update@2, with the rev-2 event landing while the gap-heal GET is in flight, should converge on rev 3 with the rev-3 content', () => {
    const store = useConversationMessagesStore.getState();
    const CONV = 'c1';

    // rev 1 — create m1@v1, loaded by the surface. Watermark: 1.
    const gen = store.startLoad(CONV);
    store.applyLoad(CONV, gen, [msg('m1', 'v1')], undefined, 1);
    expect(useConversationMessagesStore.getState().getRev(CONV)).toBe(1);

    // rev 3 arrives FIRST. 3 > watermark+1 ⇒ gap ⇒ the subscription issues a
    // refetch. The GET reads the server's real truth: rev 3, content v3.
    const snapshotToken = useConversationMessagesStore.getState().beginServerSnapshot(CONV);

    // rev 2 arrives while that GET is in flight. 2 === watermark+1, so it is
    // contiguous and correctly applied in isolation — and recorded as a pending
    // mutation carrying the rev-2 payload.
    useConversationMessagesStore.getState().applyConfirmedMessage(CONV, msg('m1', 'v2'), 2);
    useConversationMessagesStore.getState().advanceRev(CONV, 2);
    expect(textOf(useConversationMessagesStore.getState().getEntry(CONV).messages[0])).toBe('v2');

    // The GET lands, carrying rev 3 / v3. The rev-2 pending mutation is already
    // contained in this snapshot and must NOT be replayed over it.
    useConversationMessagesStore
      .getState()
      .applyServerSnapshot(CONV, snapshotToken, [msg('m1', 'v3')], undefined, 3);

    const entry = useConversationMessagesStore.getState().getEntry(CONV);
    expect(useConversationMessagesStore.getState().getRev(CONV)).toBe(3);
    // The bug produced rev 3 / v2 here — current-looking, permanently stale.
    expect(textOf(entry.messages[0])).toBe('v3');
    expect(entry.messages).toHaveLength(1);
  });

  it('given a pending mutation NEWER than the snapshot, should still replay it (the race the replay exists for)', () => {
    const store = useConversationMessagesStore.getState();
    const CONV = 'c2';

    const gen = store.startLoad(CONV);
    store.applyLoad(CONV, gen, [msg('m1', 'v1')], undefined, 1);

    // A snapshot fetch begins, reading rev 1...
    const snapshotToken = useConversationMessagesStore.getState().beginServerSnapshot(CONV);
    // ...and a genuinely newer write lands while it is in flight.
    useConversationMessagesStore.getState().applyConfirmedMessage(CONV, msg('m1', 'v2'), 2);
    useConversationMessagesStore.getState().advanceRev(CONV, 2);

    useConversationMessagesStore
      .getState()
      .applyServerSnapshot(CONV, snapshotToken, [msg('m1', 'v1')], undefined, 1);

    const entry = useConversationMessagesStore.getState().getEntry(CONV);
    // The rev-2 write outlives the stale snapshot, and the watermark never walks back.
    expect(textOf(entry.messages[0])).toBe('v2');
    expect(useConversationMessagesStore.getState().getRev(CONV)).toBe(2);
  });

  it('given a deletion at a rev the snapshot already contains, should not resurrect-then-redelete across the heal', () => {
    const store = useConversationMessagesStore.getState();
    const CONV = 'c3';

    const gen = store.startLoad(CONV);
    store.applyLoad(CONV, gen, [msg('m1', 'v1'), msg('m2', 'v1')], undefined, 1);

    const snapshotToken = useConversationMessagesStore.getState().beginServerSnapshot(CONV);
    useConversationMessagesStore.getState().applyDelete(CONV, 'm2', 2);
    useConversationMessagesStore.getState().advanceRev(CONV, 2);

    // The snapshot was read at rev 3 — it already reflects the rev-2 delete, and
    // also a rev-3 re-creation of that id. Replaying the stale delete would undo
    // a write the server has since made.
    useConversationMessagesStore
      .getState()
      .applyServerSnapshot(CONV, snapshotToken, [msg('m1', 'v1'), msg('m2', 'recreated')], undefined, 3);

    const entry = useConversationMessagesStore.getState().getEntry(CONV);
    expect(entry.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(textOf(entry.messages[1])).toBe('recreated');
  });
});

describe('replayPendingMutations rev gate', () => {
  const pending = (rev: number | undefined, text: string): PendingMutation => ({
    type: 'confirmedMessage',
    message: msg('m1', text),
    rev,
  });

  it('given a mutation at or below the snapshot rev, should skip it', () => {
    const out = replayPendingMutations([msg('m1', 'v3')], [pending(2, 'v2')], 3);
    expect(textOf(out[0])).toBe('v3');
    const equal = replayPendingMutations([msg('m1', 'v3')], [pending(3, 'v3-echo')], 3);
    expect(textOf(equal[0])).toBe('v3');
  });

  it('given a mutation above the snapshot rev, should apply it', () => {
    const out = replayPendingMutations([msg('m1', 'v1')], [pending(4, 'v4')], 3);
    expect(textOf(out[0])).toBe('v4');
  });

  it('given an UNVERSIONED mutation, should always apply it regardless of the snapshot rev', () => {
    // rev 0 means the emitter had no conversations row to version, and `undefined`
    // means the path carries no rev at all (SSE commit, legacy chat:* fan-out).
    // Neither proves anything about ordering, so their content must survive.
    expect(textOf(replayPendingMutations([msg('m1', 'v1')], [pending(0, 'unv')], 9)[0])).toBe('unv');
    expect(textOf(replayPendingMutations([msg('m1', 'v1')], [pending(undefined, 'unv')], 9)[0])).toBe('unv');
  });

  it('given no snapshot rev, should replay everything (pre-existing behavior)', () => {
    expect(textOf(replayPendingMutations([msg('m1', 'v1')], [pending(2, 'v2')])[0])).toBe('v2');
    expect(textOf(replayPendingMutations([msg('m1', 'v1')], [pending(2, 'v2')], null)[0])).toBe('v2');
  });

  it('given every pending mutation is superseded, should return the snapshot array unchanged by identity', () => {
    const snapshot = [msg('m1', 'v3')];
    expect(replayPendingMutations(snapshot, [pending(1, 'v1'), pending(2, 'v2')], 3)).toBe(snapshot);
  });
});
