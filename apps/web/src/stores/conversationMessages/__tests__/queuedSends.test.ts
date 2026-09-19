import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import {
  applyEnqueueQueuedSend,
  applyRemoveQueuedSend,
  applyShiftQueuedSend,
  applyClearQueuedSends,
  applySetQueuedSends,
  MAX_QUEUED_SENDS,
  type QueuedSendsByConversationId,
} from '../applyQueuedSends';
import {
  persistQueuedSends,
  readPersistedQueuedSends,
} from '../queuedSendsPersistence';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';

const msg = (id: string, text = id): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

const resetStore = () => {
  useConversationMessagesStore.setState({ queuedSendsByConversationId: {} });
};

describe('applyQueuedSends (pure functions)', () => {
  it('enqueues into a conversation never seen before', () => {
    const result = applyEnqueueQueuedSend({}, { conversationId: 'c1', message: msg('q1') });
    expect(result.c1).toEqual([msg('q1')]);
  });

  it('preserves FIFO order across enqueues', () => {
    let state: QueuedSendsByConversationId = {};
    state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg('q1') });
    state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg('q2') });
    state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg('q3') });
    expect(state.c1.map((m) => m.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('does not touch other conversations', () => {
    const initial = applyEnqueueQueuedSend({}, { conversationId: 'c1', message: msg('q1') });
    const result = applyEnqueueQueuedSend(initial, { conversationId: 'c2', message: msg('q2') });
    expect(result.c1).toBe(initial.c1);
  });

  it('no-ops when the id is already queued (idempotent re-enqueue)', () => {
    const initial = applyEnqueueQueuedSend({}, { conversationId: 'c1', message: msg('q1') });
    const result = applyEnqueueQueuedSend(initial, { conversationId: 'c1', message: msg('q1') });
    expect(result).toBe(initial);
  });

  it(`no-ops at the cap (${MAX_QUEUED_SENDS} entries) — queue full`, () => {
    let state: QueuedSendsByConversationId = {};
    for (let i = 0; i < MAX_QUEUED_SENDS; i++) {
      state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg(`q${i}`) });
    }
    const before = state;
    const result = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg('overflow') });
    expect(result).toBe(before);
    expect(result.c1).toHaveLength(MAX_QUEUED_SENDS);
  });

  it('removes one entry by id, preserving the order of the rest', () => {
    let state: QueuedSendsByConversationId = {};
    for (const id of ['q1', 'q2', 'q3']) {
      state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg(id) });
    }
    const result = applyRemoveQueuedSend(state, { conversationId: 'c1', messageId: 'q2' });
    expect(result.c1.map((m) => m.id)).toEqual(['q1', 'q3']);
  });

  it('remove no-ops when the conversation has no queue', () => {
    const result = applyRemoveQueuedSend({}, { conversationId: 'c1', messageId: 'q1' });
    expect(result).toEqual({});
  });

  it('remove no-ops when the id is not queued', () => {
    const initial = applyEnqueueQueuedSend({}, { conversationId: 'c1', message: msg('q1') });
    const result = applyRemoveQueuedSend(initial, { conversationId: 'c1', messageId: 'absent' });
    expect(result).toBe(initial);
  });

  it('shift drops the oldest entry', () => {
    let state: QueuedSendsByConversationId = {};
    for (const id of ['q1', 'q2']) {
      state = applyEnqueueQueuedSend(state, { conversationId: 'c1', message: msg(id) });
    }
    const result = applyShiftQueuedSend(state, 'c1');
    expect(result.c1.map((m) => m.id)).toEqual(['q2']);
  });

  it('shift no-ops on an empty or missing queue', () => {
    const emptyQueue = applyClearQueuedSends({}, 'c1');
    expect(applyShiftQueuedSend(emptyQueue, 'c1')).toBe(emptyQueue);
    expect(applyShiftQueuedSend({}, 'c1')).toEqual({});
  });

  it('clear empties the conversation queue', () => {
    const initial = applyEnqueueQueuedSend({}, { conversationId: 'c1', message: msg('q1') });
    const result = applyClearQueuedSends(initial, 'c1');
    expect(result.c1).toEqual([]);
  });

  it('set replaces wholesale, truncating past the cap', () => {
    const restored = Array.from({ length: MAX_QUEUED_SENDS + 3 }, (_, i) => msg(`r${i}`));
    const result = applySetQueuedSends({}, { conversationId: 'c1', messages: restored });
    expect(result.c1).toHaveLength(MAX_QUEUED_SENDS);
    expect(result.c1[MAX_QUEUED_SENDS - 1].id).toBe(`r${MAX_QUEUED_SENDS - 1}`);
  });
});

describe('queuedSendsPersistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips entries preserving ids and order', () => {
    const queue = [msg('q1', 'first'), msg('q2', 'second')];
    persistQueuedSends('c1', queue);
    expect(readPersistedQueuedSends('c1')).toEqual(queue);
  });

  it('an empty list removes the key instead of storing []', () => {
    persistQueuedSends('c1', [msg('q1')]);
    expect(window.localStorage.getItem('pagespace:queued-sends:c1')).not.toBeNull();
    persistQueuedSends('c1', []);
    expect(window.localStorage.getItem('pagespace:queued-sends:c1')).toBeNull();
    expect(readPersistedQueuedSends('c1')).toEqual([]);
  });

  it('returns [] for a missing key', () => {
    expect(readPersistedQueuedSends('never-stored')).toEqual([]);
  });

  it('returns [] for corrupt JSON instead of throwing', () => {
    window.localStorage.setItem('pagespace:queued-sends:c1', '{not json');
    expect(readPersistedQueuedSends('c1')).toEqual([]);
  });

  it('returns [] for a non-array payload', () => {
    window.localStorage.setItem('pagespace:queued-sends:c1', '{"id":"q1"}');
    expect(readPersistedQueuedSends('c1')).toEqual([]);
  });

  it('drops entries that are not queued user messages, keeping valid ones', () => {
    window.localStorage.setItem(
      'pagespace:queued-sends:c1',
      JSON.stringify(['junk', { role: 'user' }, { id: 'q1', role: 'assistant', parts: [] }, msg('q2')]),
    );
    expect(readPersistedQueuedSends('c1')).toEqual([msg('q2')]);
  });

  it('truncates an over-cap payload to MAX_QUEUED_SENDS', () => {
    const overcap = Array.from({ length: MAX_QUEUED_SENDS + 5 }, (_, i) => msg(`q${i}`));
    persistQueuedSends('c1', overcap);
    expect(readPersistedQueuedSends('c1')).toHaveLength(MAX_QUEUED_SENDS);
  });

  it('persists are capped on write too', () => {
    const overcap = Array.from({ length: MAX_QUEUED_SENDS + 5 }, (_, i) => msg(`q${i}`));
    persistQueuedSends('c1', overcap);
    const raw = JSON.parse(window.localStorage.getItem('pagespace:queued-sends:c1') ?? '[]');
    expect(raw).toHaveLength(MAX_QUEUED_SENDS);
  });

  it('survives a storage write failure (private mode / quota)', () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };
    expect(() => persistQueuedSends('c1', [msg('q1')])).not.toThrow();
    window.localStorage.setItem = original;
  });
});

describe('useConversationMessagesStore queue actions', () => {
  beforeEach(resetStore);

  it('enqueueQueuedSend returns true and appends in FIFO order', () => {
    const store = useConversationMessagesStore.getState();
    expect(store.enqueueQueuedSend('c1', msg('q1'))).toBe(true);
    expect(store.enqueueQueuedSend('c1', msg('q2'))).toBe(true);
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1.map((m) => m.id))
      .toEqual(['q1', 'q2']);
  });

  it(`enqueueQueuedSend returns false at ${MAX_QUEUED_SENDS} entries and does not append`, () => {
    for (let i = 0; i < MAX_QUEUED_SENDS; i++) {
      expect(useConversationMessagesStore.getState().enqueueQueuedSend('c1', msg(`q${i}`))).toBe(true);
    }
    expect(useConversationMessagesStore.getState().enqueueQueuedSend('c1', msg('overflow'))).toBe(false);
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1).toHaveLength(MAX_QUEUED_SENDS);
  });

  it('shiftQueuedSend returns the oldest entry and removes it; null when empty', () => {
    const store = useConversationMessagesStore.getState();
    store.enqueueQueuedSend('c1', msg('q1'));
    store.enqueueQueuedSend('c1', msg('q2'));

    expect(useConversationMessagesStore.getState().shiftQueuedSend('c1')?.id).toBe('q1');
    expect(useConversationMessagesStore.getState().shiftQueuedSend('c1')?.id).toBe('q2');
    expect(useConversationMessagesStore.getState().shiftQueuedSend('c1')).toBeNull();
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1).toEqual([]);
  });

  it('shiftQueuedSend returns null for a conversation with no queue', () => {
    expect(useConversationMessagesStore.getState().shiftQueuedSend('never-seen')).toBeNull();
  });

  it('removeQueuedSend drops the named entry only', () => {
    const store = useConversationMessagesStore.getState();
    store.enqueueQueuedSend('c1', msg('q1'));
    store.enqueueQueuedSend('c1', msg('q2'));
    store.enqueueQueuedSend('c1', msg('q3'));
    store.removeQueuedSend('c1', 'q2');
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1.map((m) => m.id))
      .toEqual(['q1', 'q3']);
  });

  it('clearQueuedSends empties the queue', () => {
    const store = useConversationMessagesStore.getState();
    store.enqueueQueuedSend('c1', msg('q1'));
    store.clearQueuedSends('c1');
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1).toEqual([]);
  });

  it('setQueuedSends restores entries with their original ids', () => {
    useConversationMessagesStore.getState().setQueuedSends('c1', [msg('kept-1'), msg('kept-2')]);
    expect(useConversationMessagesStore.getState().queuedSendsByConversationId.c1.map((m) => m.id))
      .toEqual(['kept-1', 'kept-2']);
  });
});
