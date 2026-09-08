import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxServiceInfo, SandboxServicesApi } from '../../sandbox-host';
import { createDevPreviewDetector, DEFERRED_RETRY_DELAYS_MS, type DevPreviewDetectorDeps } from '../dev-preview-detection';
import type { DevPreviewRecord, DevPreviewStore } from '../dev-preview-store';
import type { DevPreviewRowIntent } from '../dev-preview-core';
import { buildPreviewRelaySpec, PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';

const HOLDER = { kind: 'env', id: 'env1' } as const;
const INSTANCE = 'inst-1';
const NOW = new Date('2026-09-06T12:00:00Z');

function relayInfo(targetPort: number, runtime: 'node' | 'socat' = 'node', status: SandboxServiceInfo['status'] = 'running'): SandboxServiceInfo {
  const spec = buildPreviewRelaySpec({ targetPort, runtime });
  return { name: spec.name, command: spec.command, args: spec.args, status, pid: 7 };
}

function harness(overrides: {
  relay?: SandboxServiceInfo | null;
  row?: DevPreviewRecord | null;
  instance?: string | null;
  runtime?: 'node' | 'socat';
  failCreate?: boolean;
  /** What the PLANNER sees, when the stored row has already moved on (the stop/detection race). */
  readsAheadOfWrites?: DevPreviewRecord | null;
  /** Refuse the holder's lock this many times, then acquire. */
  lockBusyTimes?: number;
} = {}) {
  let relay: SandboxServiceInfo | null = overrides.relay ?? null;
  let row: DevPreviewRecord | null = overrides.row ?? null;
  const calls: string[] = [];
  const logs: string[] = [];
  let probes = 0;
  const services: SandboxServicesApi = {
    create: async (args) => {
      calls.push(`create:${args.args?.[args.args.length - 1]}`);
      if (overrides.failCreate) throw new Error('bind failed');
      relay = { name: args.name, command: args.command, args: args.args ?? [], status: 'running', pid: 9 };
    },
    list: async () => (relay ? [relay] : []),
    get: async (name) => (relay && relay.name === name ? relay : null),
    start: async (name) => { calls.push(`start:${name}`); },
    stop: async (name) => { calls.push(`stop:${name}`); },
    remove: async (name) => { calls.push(`remove:${name}`); relay = null; },
  };
  const store: DevPreviewStore = {
    approvePort: async () => null,
    findStoppedWithRelay: async () => [],
    markSwept: async () => {},
    markRelayStopped: async () => {},
    // `readsAheadOfWrites` models the real race: the planner reads the row as
    // it was, and by the time the write lands the STORED row has moved on
    // (a user's stop). The write then meets the same compare-and-set the real
    // store applies.
    findByHolder: async () => overrides.readsAheadOfWrites ?? row,
    upsert: async (intent: DevPreviewRowIntent) => {
      // No relay name means the row serves nothing through 8080: the user's
      // own server IS 8080 ('direct'), or the port is not shared yet.
      calls.push(`upsert:${intent.targetPort}:${intent.relayServiceName ?? (intent.targetPort === 8080 ? 'direct' : 'unshared')}`);
      const storedIntent = row === null || row.spriteInstanceId !== intent.spriteInstanceId ? null : row.stoppedByUserAt;
      const guardHolds = row !== null && row.spriteInstanceId !== intent.spriteInstanceId
        ? true
        : (storedIntent?.getTime() ?? null) === (intent.basedOnStoppedByUserAt?.getTime() ?? null);
      if (!guardHolds) {
        calls.push('upsert-refused');
        return false;
      }
      row = { id: 'r', spriteInstanceId: intent.spriteInstanceId, sandboxId: intent.sandboxId, targetPort: intent.targetPort, relayServiceName: intent.relayServiceName, detectedAt: intent.detectedAt, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null };
      return true;
    },
    setStoppedByUser: async () => null,
  };
  const deps: DevPreviewDetectorDeps = {
    holder: HOLDER,
    handle: {
      sandboxId: 'sbx',
      spriteInstanceId: overrides.instance === undefined ? INSTANCE : overrides.instance,
      services,
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    },
    store,
    now: () => NOW,
    log: {
      info: (m, c) => logs.push(`info:${m}:${JSON.stringify(c ?? {})}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m, e) => logs.push(`error:${m}:${e?.message ?? ''}`),
    },
    probeRuntime: async () => { probes += 1; return overrides.runtime ?? 'node'; },
  };
  // A scripted lock: contention is a FACT here, not a timing hope.
  let busyLeft = overrides.lockBusyTimes ?? 0;
  if (overrides.lockBusyTimes !== undefined) {
    deps.lock = async (_holder, run) => {
      if (busyLeft > 0) { busyLeft -= 1; calls.push('lock-busy'); return { outcome: 'busy' }; }
      calls.push('lock-acquired');
      return { outcome: 'acquired', result: await run() };
    };
  }
  /** Refuse the NEXT `n` lock acquisitions — lets a test settle first, then contend. */
  const setBusy = (n: number) => { busyLeft = n; };
  // Timers as data: every armed retry is captured and fired by hand, so the
  // test asserts the SCHEDULE, not a wall clock.
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  deps.schedule = (run, ms) => {
    const entry = { ms, run, cancelled: false };
    timers.push(entry);
    return () => { entry.cancelled = true; };
  };
  const detector = createDevPreviewDetector(deps);
  /**
   * Fire the newest armed, uncancelled timer and let its work settle. It must
   * NOT go through `onFrame` — a frame cancels the pending retry, which is
   * exactly the thing under test.
   */
  const fired = new Set<{ ms: number }>();
  const fire = async (): Promise<boolean> => {
    const next = [...timers].reverse().find((t) => !t.cancelled && !fired.has(t));
    if (next === undefined) return false;
    fired.add(next);
    next.run();
    // The retry queues onto the detector's internal chain; drain the macrotask
    // queue so every awaited store/service call has settled.
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    return true;
  };
  return { detector, calls, logs, probes: () => probes, relay: () => relay, row: () => row, timers, fire, setBusy };
}

describe('createDevPreviewDetector — port_opened', () => {
  it('a dev server on 5173 with no relay: probes the runtime once, creates the relay, records the row', async () => {
    const h = harness();
    // An (empty) snapshot first: the accumulated set is only KNOWN once a port_list has applied.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5173, pid: 11 });
    assert({ given: 'fresh detection', should: 'record the row FIRST, then create the relay (a refused write must cost no sprite mutation)', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'] });
    assert({ given: 'fresh detection', should: 'probe exactly once', actual: h.probes(), expected: 1 });
    assert({ given: 'fresh detection', should: 'accumulate the listener', actual: h.detector.listeners(), expected: [{ port: 5173, pid: 11 }] });
  });

  it('prefers socat when the probe finds it, and re-plans with it so the created relay IS the socat spec', async () => {
    const h = harness({ runtime: 'socat' });
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    assert({ given: 'socat present', should: 'create with the socat command', actual: h.relay()?.command, expected: 'socat' });
  });

  it('does not probe when the plan touches no relay (a database port, our own relay bind, a port_closed)', async () => {
    const h = harness({ relay: relayInfo(5173) });
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5432 });
    await h.detector.onFrame({ type: 'port_opened', port: 8080, pid: 7 });
    await h.detector.onFrame({ type: 'port_closed', port: 5173 });
    assert({ given: 'ignored ports', should: 'touch nothing and never probe', actual: { calls: h.calls, probes: h.probes() }, expected: { calls: [], probes: 0 } });
    assert({ given: 'a port_closed', should: 'only drop the listener (bookkeeping, never teardown)', actual: h.detector.listeners(), expected: [{ port: 5432 }, { port: 8080, pid: 7 }] });
  });

  it('honours the core: a row for a DEAD instance is ignored and the preview is re-created on the live one', async () => {
    const stale: DevPreviewRecord = { id: 'r', spriteInstanceId: 'inst-0', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null };
    const h = harness({ row: stale });
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    assert({ given: 'stale row', should: 'replace the row for the live instance, then create', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'] });
    assert({ given: 'stale row', should: 'now name the live instance', actual: h.row()?.spriteInstanceId, expected: INSTANCE });
  });

  it('honours the core: a user-stopped preview is NOT restarted by a new detection', async () => {
    const stopped: DevPreviewRecord = { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: NOW, approvedPort: null, approvedAt: null, selectedByUserAt: null };
    const h = harness({ row: stopped });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    assert({ given: 'stoppedByUserAt set, relay not alive', should: 'do nothing', actual: h.calls, expected: [] });
  });

  it('honours the core: with no instance id nothing is planned (refuse), and nothing is written', async () => {
    const h = harness({ instance: null });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    assert({ given: 'unknown instance', should: 'refuse silently', actual: h.calls, expected: [] });
    expect(h.logs.some((l) => l.includes('"applied":"refuse"') && l.includes('instance-unknown'))).toBe(true);
  });

  it('honours the core thrash guard: an unlisted port does not displace a listening known dev port', async () => {
    const h = harness();
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    h.calls.length = 0;
    await h.detector.onFrame({ type: 'port_opened', port: 9229 });
    assert({ given: 'node inspector after vite', should: 'keep the vite relay', actual: h.calls, expected: [] });
  });

  it('re-points the relay when a known dev port appears on a different port', async () => {
    const h = harness({ relay: relayInfo(5173), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null } });
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 3000 });
    assert({ given: 'next dev after vite', should: 'upsert, then remove and re-create on the new port', actual: h.calls, expected: [`upsert:3000:${PREVIEW_RELAY_SERVICE_NAME}`, `remove:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:3000'] });
  });
});

describe('createDevPreviewDetector — port_list snapshot', () => {
  it('replaces the listener set and plans the known dev port first', async () => {
    const h = harness();
    // 1111 is unlisted, so it is RECORDED and nothing is started — there is
    // no relay for the later snapshot to re-point, only a target to move.
    await h.detector.onFrame({ type: 'port_opened', port: 1111 });
    assert({ given: 'an unlisted 1111', should: 'record the port and start nothing', actual: h.calls, expected: ['upsert:1111:unshared'] });
    h.calls.length = 0;
    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 9229 }, { port: 5432 }, { port: 5173, pid: 3 }] });
    assert({ given: 'a snapshot with inspector, db and vite', should: 'replace listeners', actual: h.detector.listeners(), expected: [{ port: 9229 }, { port: 5432 }, { port: 5173, pid: 3 }] });
    assert({ given: 'the snapshot', should: 'take vite as the target and relay it (the inspector is never a candidate over a known port)', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'] });
  });

  it('plans ONE candidate per snapshot: two known dev ports do not replace each other, and a still-listening row target wins', async () => {
    const h = harness();
    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 5173 }, { port: 3000 }] });
    assert({ given: 'vite and next both listening, no row', should: 'plan only the lowest known port', actual: h.calls, expected: [`upsert:3000:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:3000'] });
    h.calls.length = 0;
    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 5173 }, { port: 3000 }] });
    assert({ given: 'the same snapshot again (a reconnect)', should: 'change nothing', actual: h.calls, expected: [] });
    const g = harness({ relay: relayInfo(5173), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null } });
    await g.detector.onFrame({ type: 'port_list', ports: [{ port: 3000 }, { port: 5173 }] });
    assert({ given: 'a row on 5173 still listening beside 3000', should: 'keep the working preview', actual: g.calls, expected: [] });
  });

  it('with no candidate, reconciles the row (a crashed relay is restarted; a row without a relay gets one)', async () => {
    const h = harness({ relay: relayInfo(5173, 'node', 'failed'), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null } });
    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 5432 }] });
    assert({ given: 'a failed relay and a row', should: 'start it again', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, `start:${PREVIEW_RELAY_SERVICE_NAME}`] });
  });
});

describe('createDevPreviewDetector — discipline', () => {
  it('processes frames strictly in order, one at a time', async () => {
    const h = harness();
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    const a = h.detector.onFrame({ type: 'port_opened', port: 5173 });
    const b = h.detector.onFrame({ type: 'port_opened', port: 3000 });
    await Promise.all([a, b]);
    assert({
      given: 'two frames fired without awaiting',
      should: 'plan 5173 first, then replace with 3000',
      actual: h.calls,
      expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173', `upsert:3000:${PREVIEW_RELAY_SERVICE_NAME}`, `remove:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:3000'],
    });
  });

  it('a failed effect is logged, writes no row, and does not poison the next frame', async () => {
    const h = harness({ failCreate: true });
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    // Row-first: the row IS written before the failing create, and that is
    // what makes the failure recoverable — the next frame reads a row naming
    // a relay the sprite lacks and plans the create again. What must not
    // happen is a poisoned chain, which the following frame proves.
    assert({ given: 'create threw', should: 'log, and leave the row ahead of the sprite', actual: { calls: h.calls, target: h.row()?.targetPort ?? null }, expected: { calls: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'], target: 5173 } });
    expect(h.logs.some((l) => l.startsWith('error:dev-preview: frame failed:bind failed'))).toBe(true);
    await expect(h.detector.onFrame({ type: 'port_closed', port: 5173 })).resolves.toBeUndefined();
  });

  it('owns snapshot validity: listeners() is null until a port_list has APPLIED, and invalidateSnapshot() is queued on the chain so a snapshot behind it lands first', async () => {
    const { detector } = harness();
    assert({ given: 'no frame yet', should: 'know nothing', actual: detector.listeners(), expected: null });
    void detector.onFrame({ type: 'port_opened', port: 5173, pid: 3 });
    await new Promise((r) => setTimeout(r, 0));
    assert({ given: 'an increment with no snapshot', should: 'still know nothing', actual: detector.listeners(), expected: null });
    const applied = detector.onFrame({ type: 'port_list', ports: [{ port: 3000, pid: 9 }] });
    assert({ given: 'a snapshot that has ARRIVED but not applied', should: 'still be null', actual: detector.listeners(), expected: null });
    await applied;
    assert({ given: 'an applied snapshot', should: 'be known', actual: detector.listeners(), expected: [{ port: 3000, pid: 9 }] });
    // Drop: the invalidation takes effect AT ONCE (a reader between the close
    // and the next snapshot must not see the dead connection's set)...
    const late = detector.onFrame({ type: 'port_list', ports: [{ port: 4000 }] });
    detector.invalidateSnapshot();
    assert({ given: 'a socket close', should: 'be unknown immediately, not after the queue drains', actual: detector.listeners(), expected: null });
    // ...and the closed connection's snapshot, applying afterwards, cannot claim it back.
    await late;
    await new Promise((r) => setTimeout(r, 0));
    assert({ given: 'a snapshot from the closed connection applying late', should: 'stay unknown', actual: detector.listeners(), expected: null });
    await detector.onFrame({ type: 'port_list', ports: [{ port: 5000 }] });
    assert({ given: 'the next connection\'s snapshot', should: 'be known again', actual: detector.listeners(), expected: [{ port: 5000 }] });
  });

  it('USER INTENT WINS THE RACE: a frame that planned from a row read BEFORE the user\'s stop starts the relay but cannot clear the stop — the click survives, and the next frame plans from the row that won', async () => {
    const stoppedAt = new Date('2026-09-06T13:00:00.000Z');
    const stored = { id: 'r', spriteInstanceId: 'inst-1', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: new Date('2026-09-06T12:00:00.000Z'), stoppedByUserAt: stoppedAt, approvedPort: null, approvedAt: null, selectedByUserAt: null };
    // The planner reads the PRE-stop row; the store already holds the stop.
    const h = harness({ row: stored, readsAheadOfWrites: { ...stored, stoppedByUserAt: null, approvedPort: null, approvedAt: null, selectedByUserAt: null }, relay: relayInfo(5173, 'node', 'failed') });
    // The platform sends a `port_list` on connect, always; without it the
    // accumulated set is NOT a current picture of the sprite and the core
    // refuses to plan a relay start against it.
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    await h.detector.onFrame({ type: 'port_opened', port: 5173, pid: 11 });
    assert({ given: 'a stop that landed after the plan\'s read', should: 'attempt the write and be refused by the guard', actual: h.calls.includes('upsert-refused'), expected: true });
    assert({ given: 'the refused write', should: 'leave the user\'s stop intact', actual: h.row()?.stoppedByUserAt, expected: stoppedAt });
  });

  it('will not start a relay from a set that is not a CURRENT picture of the sprite', async () => {
    // A `port_opened` before this connection's `port_list` — or one still
    // queued behind a drop — carries no evidence about port 8080. Planning a
    // relay start from it is exactly the "unknown read as free" the core
    // refuses; the platform's own snapshot lands moments later and the same
    // detection then starts for real.
    const h = harness();
    await h.detector.onFrame({ type: 'port_opened', port: 5173, pid: 11 });
    assert({ given: 'a detection before any snapshot', should: 'start nothing', actual: h.calls, expected: [] });
    assert({ given: 'no snapshot yet', should: 'report the set as unknown', actual: h.detector.listeners(), expected: null });

    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 5173, pid: 11 }] });
    assert({ given: 'the snapshot arriving', should: 'start the relay for real', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'] });
  });
});

describe('createDevPreviewDetector — a deferred reconcile is retried', () => {
  it('a frame refused by the lock is RE-ATTEMPTED, and the retry starts the relay', async () => {
    // The gap this closes: a dev server binds once and then sits quiet, so
    // there is no second frame; the backstop sweep only ever sees rows that
    // are switched OFF and still name a relay, so a preview that never
    // started is invisible to it; a healthy watcher is never recycled, so no
    // reconnect snapshot arrives; and the status read plans nothing. Drop the
    // frame and the user's running dev server simply never gets a preview,
    // with no error anywhere.
    const h = harness({ lockBusyTimes: 0 });
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    h.setBusy(1);
    await h.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });

    assert({
      given: 'a port_opened whose reconcile the lock refused',
      should: 'have started NOTHING yet, and armed exactly one retry',
      actual: [h.calls.filter((c) => c.startsWith('create')).length, h.timers.filter((t) => !t.cancelled).length],
      expected: [0, 1],
    });
    assert({
      given: 'the first retry',
      should: 'be armed at the first delay in the schedule',
      actual: h.timers[0]?.ms,
      expected: DEFERRED_RETRY_DELAYS_MS[0],
    });

    assert({ given: 'the armed retry firing', should: 'have run', actual: await h.fire(), expected: true });
    assert({
      given: 'a lock that is now free',
      should: 'create the relay for the port the dropped frame carried',
      actual: h.calls.filter((c) => c.startsWith('create:')),
      expected: ['create:5173'],
    });
  });

  it('gives up after a BOUNDED number of attempts rather than retrying forever', async () => {
    const h = harness({ lockBusyTimes: 0 });
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    h.setBusy(99);
    await h.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });

    let fires = 0;
    while (await h.fire()) fires += 1;
    assert({
      given: 'a lock that never frees',
      should: 'retry exactly as many times as the schedule has delays, then stop',
      actual: fires,
      expected: DEFERRED_RETRY_DELAYS_MS.length,
    });
    assert({
      given: 'the exhausted schedule',
      should: 'say so rather than failing silently',
      actual: h.logs.some((l) => l.startsWith('warn:dev-preview: giving up on a deferred reconcile')),
      expected: true,
    });
    assert({
      given: 'every attempt refused',
      should: 'never have touched the sprite',
      actual: h.calls.filter((c) => c.startsWith('create') || c.startsWith('start')),
      expected: [],
    });
  });

  it('a retry that has already FIRED is still superseded by the newer frame it queued behind', async () => {
    // Firing is not running. The timer callback drops its canceller and
    // appends to the chain, so between those two points a newer frame can
    // reconcile — and without a generation check the stale retry then runs
    // LAST and re-points the relay back to the port the newer frame left.
    const h = harness({ lockBusyTimes: 0 });
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    h.setBusy(1);
    await h.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });

    // The ORDER is the whole point: the newer frame is queued FIRST and is
    // still in flight, and the timer fires while it is — so the retry lands
    // BEHIND it on the chain and would otherwise get the last word.
    const newer = h.detector.onFrame({ type: 'port_opened', port: 3000, address: '10.0.0.1', pid: 384 });
    const armed = h.timers.filter((t) => !t.cancelled);
    armed[armed.length - 1]?.run();
    await newer;
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));

    assert({
      given: 'a fired-but-queued retry for 5173 and a newer frame that took 3000',
      should: 'leave the relay on 3000 — the stale retry must not re-point it',
      actual: h.calls.filter((c) => c.startsWith('create:')),
      expected: ['create:3000'],
    });
    assert({
      given: 'the superseded retry',
      should: 'say so rather than silently doing nothing',
      actual: h.logs.some((l) => l.startsWith('info:dev-preview: deferred retry superseded')),
      expected: true,
    });
  });

  it('a retry whose OWN port closes is cancelled — a relay to a server that has gone is worse than none', async () => {
    const h = harness({ lockBusyTimes: 0 });
    await h.detector.onFrame({ type: 'port_list', ports: [] });
    h.setBusy(1);
    await h.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });
    await h.detector.onFrame({ type: 'port_closed', port: 5173 });

    assert({
      given: 'the detected port closing before the retry fires',
      should: 'cancel it — the planner takes detected.port without checking it still listens',
      actual: h.timers.filter((t) => !t.cancelled).length,
      expected: 0,
    });
    await h.fire();
    assert({
      given: 'the cancelled retry',
      should: 'never create a relay for the closed port',
      actual: h.calls.filter((c) => c.startsWith('create:')),
      expected: [],
    });
  });

  it('a NEW frame supersedes the pending retry, and a dropped connection cancels it', async () => {
    const superseded = harness({ lockBusyTimes: 0 });
    await superseded.detector.onFrame({ type: 'port_list', ports: [] });
    superseded.setBusy(1);
    await superseded.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });
    await superseded.detector.onFrame({ type: 'port_opened', port: 3000, address: '10.0.0.1', pid: 384 });
    assert({
      given: 'a newer frame that RECONCILES arriving before the retry fires',
      should: 'leave no armed retry — the successful reconcile supersedes it',
      actual: superseded.timers.filter((t) => !t.cancelled).length,
      expected: 0,
    });

    // The counterweight, and the reason `onFrame` does NOT cancel blindly: a
    // frame that reconciles NOTHING must leave the pending retry alone, or an
    // unrelated port closing would silently reintroduce the dropped-frame bug.
    const unrelated = harness({ lockBusyTimes: 0 });
    await unrelated.detector.onFrame({ type: 'port_list', ports: [] });
    unrelated.setBusy(1);
    await unrelated.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });
    await unrelated.detector.onFrame({ type: 'port_closed', port: 4321 });
    assert({
      given: 'an unrelated port_closed while a retry is pending',
      should: 'leave the retry armed',
      actual: unrelated.timers.filter((t) => !t.cancelled).length,
      expected: 1,
    });
    assert({
      given: 'that still-armed retry firing',
      should: 'start the relay the dropped frame was for',
      actual: (await unrelated.fire()) && unrelated.calls.filter((c) => c.startsWith('create:')).length === 1,
      expected: true,
    });

    const dropped = harness({ lockBusyTimes: 0 });
    await dropped.detector.onFrame({ type: 'port_list', ports: [] });
    dropped.setBusy(1);
    await dropped.detector.onFrame({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 });
    dropped.detector.invalidateSnapshot();
    assert({
      given: 'the watch connection dropping',
      should: 'cancel the retry — the next connection reconciles from a real snapshot',
      actual: dropped.timers.filter((t) => !t.cancelled).length,
      expected: 0,
    });
  });
});
