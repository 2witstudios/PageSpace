import { describe, it, expect, beforeEach } from 'vitest';
import { useOptimisticConversationsStore } from '../useOptimisticConversationsStore';

const reset = () => useOptimisticConversationsStore.setState({ byKey: {} });

describe('useOptimisticConversationsStore', () => {
  beforeEach(reset);

  it('given an empty store, when adding an entry, should expose it under the cache key', () => {
    useOptimisticConversationsStore.getState().add('/key/a', {
      id: 'conv-1',
      title: 'Hello',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    expect(useOptimisticConversationsStore.getState().byKey['/key/a']).toEqual([
      { id: 'conv-1', title: 'Hello', createdAt: '2026-05-01T00:00:00.000Z' },
    ]);
  });

  it('given two entries added in sequence, should preserve insertion order with the newest first', () => {
    const { add } = useOptimisticConversationsStore.getState();
    add('/key/a', { id: 'conv-1', title: 'First', createdAt: '2026-05-01T00:00:00.000Z' });
    add('/key/a', { id: 'conv-2', title: 'Second', createdAt: '2026-05-01T00:00:01.000Z' });

    const entries = useOptimisticConversationsStore.getState().byKey['/key/a'];
    expect(entries.map((e) => e.id)).toEqual(['conv-2', 'conv-1']);
  });

  it('given an entry with an id already present, should be a no-op (dedup)', () => {
    const { add } = useOptimisticConversationsStore.getState();
    add('/key/a', { id: 'conv-1', title: 'Original', createdAt: '2026-05-01T00:00:00.000Z' });
    add('/key/a', { id: 'conv-1', title: 'Different', createdAt: '2026-05-01T00:00:01.000Z' });

    const entries = useOptimisticConversationsStore.getState().byKey['/key/a'];
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Original');
  });

  it('given entries under different cache keys, should keep them isolated', () => {
    const { add } = useOptimisticConversationsStore.getState();
    add('/key/a', { id: 'conv-a', title: 'A', createdAt: '2026-05-01T00:00:00.000Z' });
    add('/key/b', { id: 'conv-b', title: 'B', createdAt: '2026-05-01T00:00:01.000Z' });

    expect(useOptimisticConversationsStore.getState().byKey['/key/a'].map((e) => e.id)).toEqual(['conv-a']);
    expect(useOptimisticConversationsStore.getState().byKey['/key/b'].map((e) => e.id)).toEqual(['conv-b']);
  });

  it('given prune called with ids matching stored entries, should remove those entries', () => {
    const { add, prune } = useOptimisticConversationsStore.getState();
    add('/key/a', { id: 'conv-1', title: 'One', createdAt: '2026-05-01T00:00:00.000Z' });
    add('/key/a', { id: 'conv-2', title: 'Two', createdAt: '2026-05-01T00:00:01.000Z' });
    add('/key/a', { id: 'conv-3', title: 'Three', createdAt: '2026-05-01T00:00:02.000Z' });

    prune('/key/a', ['conv-1', 'conv-3']);

    const entries = useOptimisticConversationsStore.getState().byKey['/key/a'];
    expect(entries.map((e) => e.id)).toEqual(['conv-2']);
  });

  it('given prune called with no matching ids, should leave the bucket unchanged (referential identity preserved)', () => {
    const { add, prune } = useOptimisticConversationsStore.getState();
    add('/key/a', { id: 'conv-1', title: 'One', createdAt: '2026-05-01T00:00:00.000Z' });
    const before = useOptimisticConversationsStore.getState().byKey['/key/a'];

    prune('/key/a', ['conv-other']);

    expect(useOptimisticConversationsStore.getState().byKey['/key/a']).toBe(before);
  });

  it('given prune called for a cache key with no entries, should be a no-op', () => {
    const { prune } = useOptimisticConversationsStore.getState();
    prune('/key/missing', ['conv-1']);

    expect(useOptimisticConversationsStore.getState().byKey).toEqual({});
  });
});
