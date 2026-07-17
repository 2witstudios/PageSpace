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

  it('given markAnswering, should add the toolCallId to the set', () => {
    useAskUserAnsweringStore.getState().markAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(true);
  });

  it('given clearAnswering, should remove the toolCallId from the set', () => {
    useAskUserAnsweringStore.getState().markAnswering('tc1');
    useAskUserAnsweringStore.getState().clearAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('given markAnswering called twice for the same id, should be a no-op the second time (same set reference)', () => {
    useAskUserAnsweringStore.getState().markAnswering('tc1');
    const first = useAskUserAnsweringStore.getState().answeringToolCallIds;
    useAskUserAnsweringStore.getState().markAnswering('tc1');
    const second = useAskUserAnsweringStore.getState().answeringToolCallIds;
    expect(second).toBe(first);
  });

  it('given clearAnswering for an id not in the set, should be a no-op (same set reference)', () => {
    const first = useAskUserAnsweringStore.getState().answeringToolCallIds;
    useAskUserAnsweringStore.getState().clearAnswering('never-marked');
    const second = useAskUserAnsweringStore.getState().answeringToolCallIds;
    expect(second).toBe(first);
  });

  it('given two different toolCallIds marked, should track both independently', () => {
    useAskUserAnsweringStore.getState().markAnswering('tc1');
    useAskUserAnsweringStore.getState().markAnswering('tc2');
    useAskUserAnsweringStore.getState().clearAnswering('tc1');
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc2')).toBe(true);
  });
});
