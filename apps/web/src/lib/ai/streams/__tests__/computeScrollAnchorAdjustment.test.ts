import { describe, it, expect } from 'vitest';
import { computeScrollAnchorAdjustment } from '../computeScrollAnchorAdjustment';

describe('computeScrollAnchorAdjustment', () => {
  it('given an older page prepended (tail unchanged, array grew, height grew), should return the height delta', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: ['m1', 'm2'],
      nextMessageIds: ['older1', 'older2', 'm1', 'm2'],
      prevScrollHeight: 400,
      nextScrollHeight: 700,
    });
    expect(adjustment).toBe(300);
  });

  it('given a live stream APPENDING a new message (tail changed), should return 0 — never compensate an append', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: ['m1', 'm2'],
      nextMessageIds: ['m1', 'm2', 'm3-streaming'],
      prevScrollHeight: 400,
      nextScrollHeight: 500,
    });
    expect(adjustment).toBe(0);
  });

  it('given a live stream growing its OWN last message content (array length unchanged), should return 0', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: ['m1', 'm2'],
      nextMessageIds: ['m1', 'm2'],
      prevScrollHeight: 400,
      nextScrollHeight: 420,
    });
    expect(adjustment).toBe(0);
  });

  it('given the initial mount (prevMessageIds empty), should return 0', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: [],
      nextMessageIds: ['m1'],
      prevScrollHeight: 0,
      nextScrollHeight: 100,
    });
    expect(adjustment).toBe(0);
  });

  it('given the array shrank (a delete), should return 0', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: ['m1', 'm2'],
      nextMessageIds: ['m1'],
      prevScrollHeight: 400,
      nextScrollHeight: 200,
    });
    expect(adjustment).toBe(0);
  });

  it('given a genuine prepend but scrollHeight somehow did not grow, should return 0 (never a negative adjustment)', () => {
    const adjustment = computeScrollAnchorAdjustment({
      prevMessageIds: ['m1'],
      nextMessageIds: ['older1', 'm1'],
      prevScrollHeight: 400,
      nextScrollHeight: 400,
    });
    expect(adjustment).toBe(0);
  });
});
