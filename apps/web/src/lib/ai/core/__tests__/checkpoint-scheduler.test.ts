import { describe, it, expect } from 'vitest';
import {
  decideCheckpoint,
  CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS,
  type CheckpointDecisionInput,
} from '../checkpoint-scheduler';

const NOW = new Date('2026-07-14T12:00:00.000Z').getTime();

const input = (overrides: Partial<CheckpointDecisionInput> = {}): CheckpointDecisionInput => ({
  dirty: true,
  isToolBoundary: false,
  persistInFlight: false,
  lastPersistAt: NOW - CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS,
  heartbeatDeadline: NOW + 60_000,
  now: NOW,
  ...overrides,
});

describe('decideCheckpoint', () => {
  // persistInFlight ordering — never start a second checkpoint write while one is still in
  // flight, no matter how compelling the other signals are. A slow write must never be
  // clobbered by a second write racing it (the exact invariant persistInFlight exists to
  // protect in stream-lifecycle.ts).
  it('given a persist already in flight, should skip even when dirty and past the throttle window', () => {
    expect(decideCheckpoint(input({ persistInFlight: true }))).toBe(false);
  });

  it('given a persist already in flight, should skip even on a tool-boundary part', () => {
    expect(decideCheckpoint(input({ persistInFlight: true, isToolBoundary: true }))).toBe(false);
  });

  // The checkpoint must obey the same horizon as the heartbeat interval — a generation past
  // MAX_HEARTBEAT_MS must be allowed to go stale so the next takeover can reconcile it, not
  // kept an immortal ghost by a checkpoint write that keeps refreshing lastHeartbeatAt.
  it('given now is past the heartbeat deadline, should skip', () => {
    expect(decideCheckpoint(input({ now: NOW + 61_000, heartbeatDeadline: NOW + 60_000 }))).toBe(false);
  });

  it('given now is past the heartbeat deadline, should skip even on a tool-boundary part', () => {
    expect(
      decideCheckpoint(input({ now: NOW + 61_000, heartbeatDeadline: NOW + 60_000, isToolBoundary: true })),
    ).toBe(false);
  });

  it('given now is exactly at the heartbeat deadline, should still allow a flush (the horizon is exclusive)', () => {
    expect(decideCheckpoint(input({ now: NOW + 60_000, heartbeatDeadline: NOW + 60_000 }))).toBe(true);
  });

  it('given nothing unpersisted since the last checkpoint, should skip', () => {
    expect(decideCheckpoint(input({ dirty: false }))).toBe(false);
  });

  it('given nothing unpersisted since the last checkpoint, should skip even on a tool-boundary part', () => {
    expect(decideCheckpoint(input({ dirty: false, isToolBoundary: true }))).toBe(false);
  });

  // Tool boundaries flush immediately — a rejoining client should see "tool call started" or
  // "tool call finished" without waiting out the 1s throttle.
  it('given a tool-boundary part and a dirty buffer, should flush immediately even inside the throttle window', () => {
    expect(decideCheckpoint(input({ isToolBoundary: true, lastPersistAt: NOW - 1 }))).toBe(true);
  });

  it('given a dirty buffer at least 1s since the last checkpoint, should flush', () => {
    expect(
      decideCheckpoint(input({ lastPersistAt: NOW - CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS })),
    ).toBe(true);
  });

  it('given a dirty buffer less than 1s since the last checkpoint, should skip', () => {
    expect(
      decideCheckpoint(input({ lastPersistAt: NOW - (CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS - 1) })),
    ).toBe(false);
  });

  it('given a dirty buffer more than 1s since the last checkpoint, should flush', () => {
    expect(
      decideCheckpoint(input({ lastPersistAt: NOW - (CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS + 500) })),
    ).toBe(true);
  });
});
