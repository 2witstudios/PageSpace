import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { mergeSnapshotTail } from '../mergeSnapshotTail';

const msg = (id: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: id }] }) as UIMessage;
const ids = (list: UIMessage[]) => list.map((m) => m.id);

describe('mergeSnapshotTail', () => {
  it('given the snapshot overlaps the cached window, should preserve the older cached prefix in front of the snapshot', () => {
    const cached = [msg('a'), msg('b'), msg('c'), msg('d')];
    const snapshot = [msg('c'), msg('d'), msg('e')];
    const result = mergeSnapshotTail(cached, snapshot);
    expect(ids(result.messages)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.overlapped).toBe(true);
  });

  it('given overlapping rows with updated content, the SNAPSHOT versions should win for the overlapped range', () => {
    const cached = [msg('a'), { ...msg('b'), parts: [{ type: 'text', text: 'stale' }] } as UIMessage];
    const snapshot = [{ ...msg('b'), parts: [{ type: 'text', text: 'fresh' }] } as UIMessage, msg('c')];
    const result = mergeSnapshotTail(cached, snapshot);
    expect(ids(result.messages)).toEqual(['a', 'b', 'c']);
    expect(result.messages[1].parts).toEqual([{ type: 'text', text: 'fresh' }]);
  });

  it('given the snapshot fully covers the cache, should return exactly the snapshot', () => {
    const cached = [msg('a'), msg('b')];
    const snapshot = [msg('a'), msg('b'), msg('c')];
    const result = mergeSnapshotTail(cached, snapshot);
    expect(ids(result.messages)).toEqual(['a', 'b', 'c']);
    expect(result.overlapped).toBe(true);
  });

  it('given no overlap (snapshot window is entirely newer), should return the snapshot alone with overlapped=false (no invented middle gap)', () => {
    const cached = [msg('a'), msg('b')];
    const snapshot = [msg('x'), msg('y')];
    const result = mergeSnapshotTail(cached, snapshot);
    expect(ids(result.messages)).toEqual(['x', 'y']);
    expect(result.overlapped).toBe(false);
  });

  it('given an empty cache, should return the snapshot', () => {
    const result = mergeSnapshotTail([], [msg('x')]);
    expect(ids(result.messages)).toEqual(['x']);
    expect(result.overlapped).toBe(false);
  });

  it('given an empty snapshot, should return empty (server truth: nothing exists)', () => {
    const result = mergeSnapshotTail([msg('a')], []);
    expect(result.messages).toEqual([]);
    expect(result.overlapped).toBe(false);
  });

  it('should not mutate its inputs', () => {
    const cached = [msg('a'), msg('b')];
    const snapshot = [msg('b'), msg('c')];
    const cachedCopy = [...cached];
    const snapshotCopy = [...snapshot];
    mergeSnapshotTail(cached, snapshot);
    expect(cached).toEqual(cachedCopy);
    expect(snapshot).toEqual(snapshotCopy);
  });
});
