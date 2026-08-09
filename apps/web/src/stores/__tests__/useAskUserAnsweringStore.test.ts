import { describe, it, expect, beforeEach } from 'vitest';
import { useAskUserAnsweringStore } from '../useAskUserAnsweringStore';

describe('useAskUserAnsweringStore', () => {
  beforeEach(() => {
    for (const id of useAskUserAnsweringStore.getState().answeringToolCallIds) {
      useAskUserAnsweringStore.getState().clearAnswering(id);
    }
  });

  it('given no marks, should start with an empty set', () => {
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.size).toBe(0);
  });

  it('given claimAnswering on an unclaimed id, should add it to the set and return true', () => {
    const won = useAskUserAnsweringStore.getState().claimAnswering('tc1');
    expect(won).toBe(true);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(true);
  });

  it('given clearAnswering, should remove the toolCallId from the set', () => {
    useAskUserAnsweringStore.getState().claimAnswering('tc1');
    useAskUserAnsweringStore.getState().clearAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('given claimAnswering called twice for the same id, the second call should return false (the mutex) and not change the set reference', () => {
    useAskUserAnsweringStore.getState().claimAnswering('tc1');
    const first = useAskUserAnsweringStore.getState().answeringToolCallIds;
    const wonAgain = useAskUserAnsweringStore.getState().claimAnswering('tc1');
    const second = useAskUserAnsweringStore.getState().answeringToolCallIds;
    expect(wonAgain).toBe(false);
    expect(second).toBe(first);
  });

  it('given clearAnswering for an id not in the set, should be a no-op (same set reference)', () => {
    const first = useAskUserAnsweringStore.getState().answeringToolCallIds;
    useAskUserAnsweringStore.getState().clearAnswering('never-marked');
    const second = useAskUserAnsweringStore.getState().answeringToolCallIds;
    expect(second).toBe(first);
  });

  it('given two different toolCallIds claimed, should track both independently', () => {
    useAskUserAnsweringStore.getState().claimAnswering('tc1');
    useAskUserAnsweringStore.getState().claimAnswering('tc2');
    useAskUserAnsweringStore.getState().clearAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc2')).toBe(true);
  });

  it('given a claim was cleared, a later claim for the same id should win again (true)', () => {
    useAskUserAnsweringStore.getState().claimAnswering('tc1');
    useAskUserAnsweringStore.getState().clearAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().claimAnswering('tc1')).toBe(true);
  });
});
