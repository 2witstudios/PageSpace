import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import {
  isStreamRowLive,
  isProvablyDead,
  decideStreamTakeover,
  STREAM_HEARTBEAT_STALE_MS,
  type StreamLivenessRow,
} from '../stream-liveness';

const NOW = new Date('2026-07-11T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms);

const row = (messageId: string, heartbeatAgoMs: number | null, startedAgoMs = heartbeatAgoMs ?? 0) => ({
  messageId,
  lastHeartbeatAt: heartbeatAgoMs === null ? null : ago(heartbeatAgoMs),
  startedAt: ago(startedAgoMs),
});

describe('isStreamRowLive', () => {
  it('given a row that checkpointed seconds ago, should be live', () => {
    expect(isStreamRowLive(row('m1', 5_000), NOW)).toBe(true);
  });

  it('given a row whose last checkpoint is older than the stale window, should be dead', () => {
    expect(isStreamRowLive(row('m1', STREAM_HEARTBEAT_STALE_MS + 1), NOW)).toBe(false);
  });

  it('given a row exactly at the stale boundary, should be dead (the window is exclusive)', () => {
    expect(isStreamRowLive(row('m1', STREAM_HEARTBEAT_STALE_MS), NOW)).toBe(false);
  });

  // Rows written before the heartbeat column existed carry null. Declaring an
  // actually-in-flight stream dead under its own feet mid-deploy would be worse than
  // being briefly generous, so fall back to startedAt.
  it('given a pre-heartbeat row (null lastHeartbeatAt) that started recently, should fall back to startedAt and be live', () => {
    expect(isStreamRowLive(row('m1', null, 10_000), NOW)).toBe(true);
  });

  it('given a pre-heartbeat row that started long ago, should be dead', () => {
    expect(isStreamRowLive(row('m1', null, STREAM_HEARTBEAT_STALE_MS * 2), NOW)).toBe(false);
  });

  it('given an explicit staleAfterMs, should use it instead of the default', () => {
    expect(isStreamRowLive(row('m1', 5_000), NOW, 1_000)).toBe(false);
    expect(isStreamRowLive(row('m1', 5_000), NOW, 60_000)).toBe(true);
  });
});

describe('decideStreamTakeover', () => {
  it('given no in-flight rows, should decide nothing', () => {
    expect(decideStreamTakeover({ rows: [], now: NOW })).toEqual({ abort: [], reconcile: [] });
  });

  // THE invariant. Aborting is free for a messageId the in-process registry doesn't
  // know (abortStreamByMessageId returns {aborted:false}; it does not throw), whereas
  // SKIPPING an abort for a row we misjudged as dead leaves a real generation running
  // and starts a second one alongside it — two agents editing the same pages, two
  // bills. The asymmetry is total, so liveness must never gate the abort.
  it('given a row that LOOKS stale, should still attempt to abort it (a liveness guess must never gate the abort)', () => {
    const decision = decideStreamTakeover({
      rows: [row('looks-dead', STREAM_HEARTBEAT_STALE_MS * 3)],
      now: NOW,
    });

    expect(decision.abort).toEqual(['looks-dead']);
  });

  it('given live and stale rows, should attempt to abort EVERY one of them', () => {
    const decision = decideStreamTakeover({
      rows: [row('live', 1_000), row('dead', STREAM_HEARTBEAT_STALE_MS * 2)],
      now: NOW,
    });

    expect(decision.abort).toEqual(['live', 'dead']);
  });

  describe('reconcile — only what we can prove is finished', () => {
    it('given a row the registry actually aborted, should reconcile it', () => {
      const decision = decideStreamTakeover({
        rows: [row('live', 1_000)],
        abortedMessageIds: ['live'],
        now: NOW,
      });

      expect(decision.reconcile).toEqual(['live']);
    });

    // A crashed generation leaves status='streaming' forever — the terminal write is
    // fire-and-forget and dies with the process. Nothing to abort, but it must be
    // driven terminal so it stops blocking and stops ghosting.
    it('given a provably dead row (stale heartbeat) that no registry aborted, should still reconcile it', () => {
      const decision = decideStreamTakeover({
        rows: [row('dead', STREAM_HEARTBEAT_STALE_MS * 3)],
        abortedMessageIds: [],
        now: NOW,
      });

      expect(decision.reconcile).toEqual(['dead']);
    });

    // The dangerous case. The abort was refused (cross-user IDOR guard on a shared
    // conversation) or not-found (the stream lives on another web instance) — but the
    // row is beating, so the generation is very much alive. Writing
    // status='aborted', parts=[] over it would hide a live stream from every
    // subscriber and destroy its only crash-recovery snapshot, while it keeps running,
    // keeps calling tools, and keeps billing.
    it('given a LIVE row we could not abort, should NOT reconcile it (never mark a running stream aborted)', () => {
      const decision = decideStreamTakeover({
        rows: [row('live-elsewhere', 1_000)],
        abortedMessageIds: [],
        now: NOW,
      });

      expect(decision.abort).toEqual(['live-elsewhere']);
      expect(decision.reconcile).toEqual([]);
    });

    it('given a mix, should reconcile the aborted and the dead but leave the un-abortable live row alone', () => {
      const decision = decideStreamTakeover({
        rows: [
          row('stopped', 1_000),
          row('dead', STREAM_HEARTBEAT_STALE_MS * 2),
          row('live-elsewhere', 2_000),
        ],
        abortedMessageIds: ['stopped'],
        now: NOW,
      });

      expect(decision.abort).toEqual(['stopped', 'dead', 'live-elsewhere']);
      expect(decision.reconcile).toEqual(['stopped', 'dead']);
    });
  });
});

describe('decideStreamTakeover — a beat that stops BY DESIGN is not a death', () => {
  // The lifecycle caps the heartbeat at STREAM_MAX_LIFETIME_MS as a backstop against a leaked
  // interval; the GENERATION has no such cap. So past the cap, silence is the expected state of a
  // perfectly healthy long run (a deep-research or tool-loop stream still going at T+61min).
  //
  // Reconciling on a stale beat there writes status='aborted', parts=[] over a stream that is STILL
  // GENERATING — hiding it from every subscriber, destroying its only crash-recovery snapshot, and
  // leaving it calling write tools and billing. That is the one write this module must never make.
  const now = new Date('2026-07-12T14:00:00Z').getTime();
  const HOUR = 60 * 60 * 1000;
  // Started 2h ago; beat right up to the 1h cap and then went silent BY DESIGN. This is what a
  // healthy long generation looks like — still running, no longer beating.
  const longRow = (over: Partial<StreamLivenessRow> = {}): StreamLivenessRow => ({
    messageId: 'msg-long',
    startedAt: new Date(now - 2 * HOUR),
    lastHeartbeatAt: new Date(now - 1 * HOUR),
    ...over,
  });

  // THE REGRESSION THIS GUARD ALMOST CAUSED. Asking "is the row old?" makes every row older than
  // the cap unreconcilable — including one whose process crashed at minute five and which nobody
  // looked at for an hour. That row is definitively dead, but it would sit at 'streaming' FOREVER:
  // a permanent ghost, poisoning every later Stop on its conversation with a false "may still be
  // running" and every later send with a warn.
  //
  // The row itself tells us which it is. A stream alive at the cap beat right UP TO it; a stream
  // that died at minute five stopped beating there. So we ask WHERE the beat stopped, not how old
  // the row is.
  it('still reconciles a process that died early, however long ago that was', () => {
    assert({
      given: 'a row whose process crashed 5 minutes in, untouched for 2 hours',
      should: 'reconcile it — a beat that stopped short of the cap is proof of death at any age',
      actual: decideStreamTakeover({
        rows: [longRow({ lastHeartbeatAt: new Date(now - 2 * 60 * 60 * 1000 + 5 * 60 * 1000) })],
        now,
      }).reconcile,
      expected: ['msg-long'],
    });
  });

  it('refuses to reconcile a row that has outlived the heartbeat cap', () => {
    assert({
      given: 'a long generation past the cap, whose heartbeat therefore stopped by design',
      should: 'leave its row alone — a silent beat is not proof of death here',
      actual: decideStreamTakeover({ rows: [longRow()], now }).reconcile,
      expected: [],
    });
  });

  // The guard must not swallow the case it sits next to: a row we ACTUALLY aborted is proven
  // finished, whatever its heartbeat says, and must still be driven terminal.
  it('still reconciles a row it actually aborted, even past the cap', () => {
    assert({
      given: 'a past-the-cap row that the abort registry actually stopped',
      should: 'reconcile it — we have proof it is finished',
      actual: decideStreamTakeover({
        rows: [longRow()],
        abortedMessageIds: ['msg-long'],
        now,
      }).reconcile,
      expected: ['msg-long'],
    });
  });
});

describe('isProvablyDead — the one predicate both terminal writers share', () => {
  // This decides the single most unforgiving write in the system, and it is unforgiving in BOTH
  // directions: reap a live stream and you erase it mid-flight (status='aborted', parts wiped,
  // hidden from every subscriber, still billing); fail to reap a dead one and it haunts its
  // conversation — the abort path's batch verdict is pessimistic, so ONE ghost row makes every
  // future Stop there report "may still be running" and every future send pay the takeover wait.
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const now = new Date('2026-07-12T14:00:00Z').getTime();

  const at = (startedAgo: number, beatAgo: number): StreamLivenessRow => ({
    messageId: 'm',
    startedAt: new Date(now - startedAgo),
    lastHeartbeatAt: new Date(now - beatAgo),
  });

  it('reaps a process that crashed early, however long ago', () => {
    // Started 2h ago, beat only for its first 5 minutes.
    assert({
      given: 'a row whose beat stopped 5 minutes in and has been silent for nearly 2 hours',
      should: 'be provably dead — a beat that stops short of the cap is a dead process at any age',
      actual: isProvablyDead(at(2 * HOUR, 2 * HOUR - 5 * MIN), now),
      expected: true,
    });
  });

  it('refuses to reap a long generation whose beat ran to the cap', () => {
    // Started 90m ago; beat right up to the 1h cap, silent since — by design, not by dying.
    assert({
      given: 'a healthy long generation past the heartbeat cap',
      should: 'NOT be provably dead — its silence is by design, and reaping it would erase it',
      actual: isProvablyDead(at(90 * MIN, 30 * MIN), now),
      expected: false,
    });
  });

  // The gap the first cap fix left open: a crash in the last minutes BEFORE the cap looks exactly
  // like a stream that ran to the cap, so it could never be judged — and would sit at 'streaming'
  // forever, poisoning its conversation. Nothing may be un-reapable indefinitely.
  it('eventually reaps even an ambiguous row, once it is beyond any plausible generation', () => {
    // Beat stopped at 59m (inside the ambiguity margin), and the row is now 3 hours old.
    assert({
      given: 'a row that crashed just before the cap, long past any plausible generation lifetime',
      should: 'be reaped by the backstop — nothing may claim to be streaming forever',
      actual: isProvablyDead(at(3 * HOUR, 3 * HOUR - 59 * MIN), now),
      expected: true,
    });
  });

  it('does not reap that same ambiguous row while it could still plausibly be running', () => {
    assert({
      given: 'a row that beat to the cap and is only 90 minutes old',
      should: 'be left alone — it may well still be generating',
      actual: isProvablyDead(at(90 * MIN, 30 * MIN), now),
      expected: false,
    });
  });

  it('never reaps a row that is still beating', () => {
    assert({
      given: 'a stream that beat 10 seconds ago',
      should: 'not be dead by any measure',
      actual: isProvablyDead(at(30 * MIN, 10_000), now),
      expected: false,
    });
  });

  // A live long generation must survive a few missed beats — a failed UPDATE, a GC pause. The
  // ambiguity margin is what buys that, and it must be several beats wide.
  it('tolerates a long generation missing several beats before the cap', () => {
    // Beat last landed 59m in (a minute short of the cap), row is 70m old.
    assert({
      given: 'a live long generation whose last beat before the cap was a minute early',
      should: 'still be treated as ambiguous, not reaped',
      actual: isProvablyDead(at(70 * MIN, 11 * MIN), now),
      expected: false,
    });
  });
});
