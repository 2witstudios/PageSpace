import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  decideWatcherActions,
  decideAbortOutcome,
  type LocalStreamEntry,
  type MarkedStreamRow,
  type SettleRow,
} from '../stream-abort-decisions';

/**
 * These are the decisions that make a cross-instance abort correct. They are pure — no DB, no
 * timers, no mocks — so every test here exercises the real logic with real inputs. A test that
 * needed a mock to pass could pass with the bug present; these cannot.
 */

const NOW = new Date('2026-07-12T12:00:00Z').getTime();
const beat = (msAgo: number) => new Date(NOW - msAgo);

const local = (over: Partial<LocalStreamEntry> = {}): LocalStreamEntry => ({
  messageId: 'msg-1',
  streamId: 'stream-1',
  userId: 'user-a',
  ...over,
});

const marked = (over: Partial<MarkedStreamRow> = {}): MarkedStreamRow => ({
  messageId: 'msg-1',
  streamId: 'stream-1',
  userId: 'user-a',
  ...over,
});

const settle = (over: Partial<SettleRow> = {}): SettleRow => ({
  messageId: 'msg-1',
  status: 'streaming',
  startedAt: beat(30_000),
  lastHeartbeatAt: beat(5_000),
  ...over,
});

describe('decideWatcherActions', () => {
  it('aborts a marked row this instance owns', () => {
    assert({
      given: 'a marked row whose messageId and streamId match a local registry entry',
      should: 'abort it, as the owner named by the row itself',
      actual: decideWatcherActions({
        localStreams: [local()],
        markedRows: [marked()],
      }),
      expected: {
        abort: [{ messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' }],
        clear: [],
        corrupt: [],
      },
    });
  });

  // A mark for a stream this instance does not own must be left completely alone — NOT cleared.
  // Clearing another instance's mark would consume the abort request without performing the
  // abort: the owner would never see it, and the user's Stop would silently do nothing. This is
  // the single easiest way to reintroduce the exact bug this change exists to fix.
  it('ignores (and does not clear) a marked row owned by another instance', () => {
    assert({
      given: 'a marked row with no matching local registry entry',
      should: 'do nothing at all, leaving the mark for the instance that owns it',
      actual: decideWatcherActions({
        localStreams: [],
        markedRows: [marked({ messageId: 'msg-elsewhere' })],
      }),
      expected: { abort: [], clear: [], corrupt: [] },
    });
  });

  // The epoch guard. A row is reused (onConflictDoUpdate) when a messageId re-registers, and the
  // re-register resets abortRequestedAt — but a cleared column is only a promise, and the next
  // person to edit that INSERT can silently break it. So a mark whose streamId names a PREVIOUS
  // generation must never be allowed to kill the CURRENT one.
  it('refuses to abort when the mark names a previous generation (stale epoch)', () => {
    assert({
      given: 'a marked row whose streamId does not match the live local entry',
      should: 'not abort, and clear the unactionable mark so it stops being re-read',
      actual: decideWatcherActions({
        localStreams: [local({ streamId: 'stream-2' })],
        markedRows: [marked({ streamId: 'stream-1' })],
      }),
      expected: { abort: [], clear: ['msg-1'], corrupt: [] },
    });
  });

  // Impossible without corruption (messageId is a per-request cuid2 PK, and the row was inserted
  // by the same route that made the registry entry). If it ever happens, aborting would stop the
  // WRONG USER's generation — so refuse, and make it loud rather than silent.
  it('refuses to abort when the row owner disagrees with the local entry owner', () => {
    assert({
      given: 'a marked row whose userId differs from the local registry entry it matches',
      should: 'refuse the abort and report it as corruption',
      actual: decideWatcherActions({
        localStreams: [local({ userId: 'user-a' })],
        markedRows: [marked({ userId: 'user-b' })],
      }),
      expected: {
        abort: [],
        clear: [],
        corrupt: [{ messageId: 'msg-1', localUserId: 'user-a', rowUserId: 'user-b' }],
      },
    });
  });

  it('acts only on the marked rows it owns, out of a mixed batch', () => {
    assert({
      given: 'marked rows for this instance, another instance, and a stale epoch',
      should: 'abort only the one it owns at the current epoch',
      actual: decideWatcherActions({
        localStreams: [local(), local({ messageId: 'msg-2', streamId: 'stream-old', userId: 'user-b' })],
        markedRows: [
          marked(),
          marked({ messageId: 'msg-2', streamId: 'stream-new', userId: 'user-b' }),
          marked({ messageId: 'msg-3', streamId: 'stream-3', userId: 'user-c' }),
        ],
      }),
      expected: {
        abort: [{ messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' }],
        clear: ['msg-2'],
        corrupt: [],
      },
    });
  });
});

describe('decideAbortOutcome', () => {
  it('reports a stream that reached a terminal status as stopped', () => {
    assert({
      given: 'a requested abort whose row is now aborted',
      should: 'confirm it stopped',
      actual: decideAbortOutcome({
        requested: ['msg-1'],
        rows: [settle({ status: 'aborted' })],
        now: NOW,
      }),
      expected: { aborted: ['msg-1'], reconcile: [], stillLive: [], code: 'aborted' },
    });
  });

  it('reports a stream that finished on its own as stopped', () => {
    assert({
      given: 'a requested abort whose row completed before the abort landed',
      should: 'confirm it stopped (a benign race, not a failure)',
      actual: decideAbortOutcome({
        requested: ['msg-1'],
        rows: [settle({ status: 'complete' })],
        now: NOW,
      }),
      expected: { aborted: ['msg-1'], reconcile: [], stillLive: [], code: 'aborted' },
    });
  });

  // The false-alarm guard. If the owning instance CRASHED, nothing will ever consume the mark and
  // the wait always times out. Reporting 'unconfirmed' here would tell the user "still running,
  // still billing" about a dead process — a lie, on the one message that must never be false.
  // A stale heartbeat is exactly what stream-liveness.ts exists to detect, so compose with it.
  it('treats a timed-out abort with a stale heartbeat as stopped, and reconciles the row', () => {
    assert({
      given: 'a row still marked streaming whose owning process has stopped beating',
      should: 'confirm it stopped and hand the row back to the caller to drive terminal',
      actual: decideAbortOutcome({
        requested: ['msg-1'],
        rows: [settle({ status: 'streaming', lastHeartbeatAt: beat(5 * 60_000) })],
        now: NOW,
      }),
      expected: { aborted: ['msg-1'], reconcile: ['msg-1'], stillLive: [], code: 'aborted' },
    });
  });

  // The ONLY case that may ever toast the user. The generation really is still running on an
  // instance that did not pick up the mark (e.g. an old worker mid rolling-deploy): still
  // generating, still calling write tools, still billing.
  it('reports a timed-out abort with a live heartbeat as unconfirmed', () => {
    assert({
      given: 'a row still streaming and still beating after the wait elapsed',
      should: 'report unconfirmed — it is genuinely still running',
      actual: decideAbortOutcome({
        requested: ['msg-1'],
        rows: [settle({ status: 'streaming', lastHeartbeatAt: beat(5_000) })],
        now: NOW,
      }),
      expected: { aborted: [], reconcile: [], stillLive: ['msg-1'], code: 'unconfirmed' },
    });
  });

  // The benign race, and the reason this code is not just `aborted ? ok : warn`. Toasting here
  // would fire constantly (Stop pressed a beat after the stream ended) and train users to ignore
  // the one warning that matters.
  it('reports no in-flight stream as not_found', () => {
    assert({
      given: 'nothing was requested because no in-flight stream was found',
      should: 'report not_found, which the client must treat as silent',
      actual: decideAbortOutcome({ requested: [], rows: [], now: NOW }),
      expected: { aborted: [], reconcile: [], stillLive: [], code: 'not_found' },
    });
  });

  it('treats a requested abort whose row has vanished as stopped', () => {
    assert({
      given: 'a requested abort with no corresponding row',
      should: 'confirm it stopped — a stream with no row cannot be running',
      actual: decideAbortOutcome({ requested: ['msg-1'], rows: [], now: NOW }),
      expected: { aborted: ['msg-1'], reconcile: [], stillLive: [], code: 'aborted' },
    });
  });

  // One still-running stream must not be masked by its stopped siblings: the user is still being
  // billed for it, so the batch verdict has to be the pessimistic one.
  it('reports unconfirmed when any one of several streams is still live', () => {
    assert({
      given: 'a batch where one stream stopped and another is still beating',
      should: 'report unconfirmed for the batch, not aborted',
      actual: decideAbortOutcome({
        requested: ['msg-1', 'msg-2'],
        rows: [
          settle({ messageId: 'msg-1', status: 'aborted' }),
          settle({ messageId: 'msg-2', status: 'streaming', lastHeartbeatAt: beat(5_000) }),
        ],
        now: NOW,
      }),
      expected: {
        aborted: ['msg-1'],
        reconcile: [],
        stillLive: ['msg-2'],
        code: 'unconfirmed',
      },
    });
  });
});
