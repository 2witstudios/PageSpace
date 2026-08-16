import { describe, it, expect } from 'vitest';
import { recordStopRequest, readStopEpoch } from '../stopRequests';

/**
 * The contract the retry dispatch guard leans on, stated here rather than inferred from the
 * hooks that use it: a snapshot taken before an await, compared after it, answers "did a Stop
 * land in between" — for THIS conversation and no other, and without anything having to decide
 * when a stop request expires.
 *
 * Deliberately no reset between cases: there is no reset to test, and its absence is the design
 * (see the module docblock). Each case uses its own conversation ids and reads a `before` rather
 * than assuming zero, which is exactly how a caller must use it.
 */
describe('stopRequests', () => {
  it('given no Stop, should read the same epoch twice', () => {
    expect(readStopEpoch('quiet')).toBe(readStopEpoch('quiet'));
  });

  it('given a Stop, should move that conversation on', () => {
    const before = readStopEpoch('moved');

    recordStopRequest('moved');

    expect(readStopEpoch('moved')).toBe(before + 1);
  });

  it('given a Stop in one conversation, should leave another where it was', () => {
    const before = readStopEpoch('untouched');

    recordStopRequest('elsewhere');

    expect(readStopEpoch('untouched')).toBe(before);
  });

  // Monotonic, not a flag: two presses inside one await window must not look like one, or a
  // caller that snapshotted between them would think nothing had happened.
  it('given repeated Stops, should keep moving rather than latch', () => {
    const before = readStopEpoch('repeated');

    recordStopRequest('repeated');
    recordStopRequest('repeated');
    recordStopRequest('repeated');

    expect(readStopEpoch('repeated')).toBe(before + 3);
  });
});
