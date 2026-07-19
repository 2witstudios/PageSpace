import { describe, it, expect } from 'vitest';
import { computeReorderPlan } from '../compute-reorder-plan';

describe('computeReorderPlan', () => {
  it('returns an empty plan for an empty array', () => {
    const plan = computeReorderPlan([]);

    expect(plan.orderedIds).toEqual([]);
    expect(plan.positionById.size).toBe(0);
  });

  it('returns a single-entry plan for a single item', () => {
    const plan = computeReorderPlan([{ id: 'a', position: 0 }]);

    expect(plan.orderedIds).toEqual(['a']);
    expect(plan.positionById.get('a')).toBe(0);
  });

  it('sorts ids ascending when input is already sorted', () => {
    const plan = computeReorderPlan([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ]);

    expect(plan.orderedIds).toEqual(['a', 'b', 'c']);
  });

  it('sorts ids ascending when input is in reverse order', () => {
    const plan = computeReorderPlan([
      { id: 'c', position: 0 },
      { id: 'b', position: 1 },
      { id: 'a', position: 2 },
    ]);

    expect(plan.orderedIds).toEqual(['a', 'b', 'c']);
  });

  it('sorts ids ascending when input is in arbitrary order', () => {
    const plan = computeReorderPlan([
      { id: 'm', position: 0 },
      { id: 'z', position: 1 },
      { id: 'a', position: 2 },
      { id: 'k', position: 3 },
    ]);

    expect(plan.orderedIds).toEqual(['a', 'k', 'm', 'z']);
  });

  it('keeps only the last occurrence of a duplicate id, and its position', () => {
    const plan = computeReorderPlan([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'a', position: 5 },
    ]);

    expect(plan.orderedIds).toEqual(['a', 'b']);
    expect(plan.positionById.get('a')).toBe(5);
    expect(plan.positionById.get('b')).toBe(1);
  });

  it('deduplicates multiple repeats of the same id, keeping the final write', () => {
    const plan = computeReorderPlan([
      { id: 'x', position: 0 },
      { id: 'x', position: 1 },
      { id: 'x', position: 2 },
    ]);

    expect(plan.orderedIds).toEqual(['x']);
    expect(plan.positionById.get('x')).toBe(2);
  });
});
