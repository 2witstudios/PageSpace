import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  shouldFlushFrames,
  FRAME_FLUSH_MAX_FRAMES,
  FRAME_FLUSH_INTERVAL_MS,
  FRAME_FLUSH_MAX_BYTES,
  type FrameFlushDecisionInput,
} from '../frame-log-batching';

const NOW = 1_000_000;

const input = (over: Partial<FrameFlushDecisionInput> = {}): FrameFlushDecisionInput => ({
  pendingFrames: 1,
  pendingBytes: 100,
  isBoundary: false,
  oldestPendingAt: NOW,
  now: NOW,
  ...over,
});

describe('shouldFlushFrames — the durable frame log\'s cadence', () => {
  it('given nothing pending, never flushes', () => {
    assert({
      given: 'an interval tick with an empty buffer',
      should: 'decline, so no empty row is ever written',
      actual: shouldFlushFrames(input({ pendingFrames: 0, pendingBytes: 0 })),
      expected: false,
    });
  });

  it('given nothing pending but a boundary reported, still never flushes', () => {
    // The empty check comes FIRST for this reason: a boundary is the strongest reason to
    // flush, and it must not be strong enough to write a row with no frames in it.
    assert({
      given: 'a boundary flag with an empty buffer',
      should: 'still decline — emptiness beats the boundary bypass',
      actual: shouldFlushFrames(input({ pendingFrames: 0, pendingBytes: 0, isBoundary: true })),
      expected: false,
    });
  });

  it('given a fast token stream, holds a single frame back rather than writing per token', () => {
    assert({
      given: 'one text delta, well inside every cap',
      should: 'decline — this is the write amplification the batching exists to avoid',
      actual: shouldFlushFrames(input()),
      expected: false,
    });
  });

  it('given a tool or step boundary, flushes immediately rather than waiting out the throttle', () => {
    assert({
      given: 'a boundary frame one millisecond into the window',
      should: 'flush, so a rejoining client sees the tool call without waiting',
      actual: shouldFlushFrames(input({ isBoundary: true, now: NOW + 1 })),
      expected: true,
    });
  });

  it('given the frame cap is reached, flushes', () => {
    assert({
      given: `${FRAME_FLUSH_MAX_FRAMES} pending frames inside the time window`,
      should: 'flush on the count alone',
      actual: shouldFlushFrames(input({ pendingFrames: FRAME_FLUSH_MAX_FRAMES })),
      expected: true,
    });
  });

  it('given one frame short of the cap, does not flush', () => {
    assert({
      given: `${FRAME_FLUSH_MAX_FRAMES - 1} pending frames`,
      should: 'decline — the cap is a floor, not an approximation',
      actual: shouldFlushFrames(input({ pendingFrames: FRAME_FLUSH_MAX_FRAMES - 1 })),
      expected: false,
    });
  });

  it('given the byte cap is reached, flushes even on a handful of frames', () => {
    assert({
      given: 'two frames carrying a large tool output',
      should: 'flush on bytes — 64 megabyte-sized frames is not a bounded write',
      actual: shouldFlushFrames(input({ pendingFrames: 2, pendingBytes: FRAME_FLUSH_MAX_BYTES })),
      expected: true,
    });
  });

  it('given one byte short of the byte cap, does not flush', () => {
    assert({
      given: `${FRAME_FLUSH_MAX_BYTES - 1} pending bytes`,
      should: 'decline',
      actual: shouldFlushFrames(input({ pendingBytes: FRAME_FLUSH_MAX_BYTES - 1 })),
      expected: false,
    });
  });

  it('given the oldest pending frame has aged out the window, flushes', () => {
    assert({
      given: `a frame buffered ${FRAME_FLUSH_INTERVAL_MS}ms ago`,
      should: 'flush — no frame waits longer than the window to become durable',
      actual: shouldFlushFrames(input({ now: NOW + FRAME_FLUSH_INTERVAL_MS })),
      expected: true,
    });
  });

  it('given the oldest pending frame is one ms short of the window, does not flush', () => {
    assert({
      given: `a frame buffered ${FRAME_FLUSH_INTERVAL_MS - 1}ms ago`,
      should: 'decline',
      actual: shouldFlushFrames(input({ now: NOW + FRAME_FLUSH_INTERVAL_MS - 1 })),
      expected: false,
    });
  });

  it('ages the OLDEST pending frame, not the newest — a trickle cannot sit unflushed forever', () => {
    // The distinction that makes this a staleness bound. A stream emitting one frame every
    // 150ms never has 64 pending and never reaches the byte cap; if the clock restarted on
    // each arrival, its frames would never become durable at all.
    assert({
      given: 'a buffer opened 250ms ago whose newest frame arrived just now',
      should: 'flush on the age of the oldest frame',
      actual: shouldFlushFrames(input({ pendingFrames: 2, oldestPendingAt: NOW - 250 })),
      expected: true,
    });
  });
});
