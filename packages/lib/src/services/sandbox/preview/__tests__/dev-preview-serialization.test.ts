/**
 * The two writers, in one process, against one store — the interleavings the
 * lock exists for.
 *
 * These are deterministic, not timing-hopeful: the lock is an injected
 * dependency, so "the detector holds it" and "the budget is spent" are
 * scripted facts, and the shared store is the single state both tiers see.
 */
import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxHandle, SandboxServiceInfo } from '../../sandbox-host';
import { planDevServerService, type DevPreviewHolderRef } from '../dev-preview-core';
import { createDevPreviewDetector } from '../dev-preview-detection';
import { applyDevPreviewUserAction } from '../dev-preview-status';
import type { DevPreviewLock } from '../dev-preview-lock';
import type { DevPreviewRecord, DevPreviewStore } from '../dev-preview-store';
import { buildPreviewRelaySpec, PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const INSTANCE = 'inst-live';
const HOLDER: DevPreviewHolderRef = { kind: 'env', id: 'env1' };
const ACTOR = { userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'owner' } };

/**
 * ONE store both tiers write to, enforcing the same compare-and-set the real
 * one does — and able to PAUSE inside a read, which is what makes the
 * interleaving a scripted fact instead of a timing accident.
 */
function sharedStore(initial: DevPreviewRecord | null) {
  let row = initial;
  const log: string[] = [];
  /** Set to hold the next `findByHolder` open until the test releases it. */
  let pause: { promise: Promise<void>; release: () => void } | null = null;
  const store: DevPreviewStore = {
    findByHolder: async () => {
      log.push('read');
      if (pause !== null) {
        const held = pause;
        pause = null;
        await held.promise;
      }
      return row;
    },
    upsert: async (intent) => {
      const sameInstance = row !== null && row.spriteInstanceId === intent.spriteInstanceId;
      const guardHolds = !sameInstance || (row?.stoppedByUserAt?.getTime() ?? null) === (intent.basedOnStoppedByUserAt?.getTime() ?? null);
      if (!guardHolds) {
        log.push('upsert-refused');
        return false;
      }
      log.push(`upsert:${intent.targetPort}`);
      const { basedOnStoppedByUserAt: _guard, ...rest } = intent;
      row = { id: 'r1', ...rest, stoppedByUserAt: null };
      return true;
    },
    setStoppedByUser: async (_holder, at) => {
      log.push(`intent:${at ? 'stop' : 'clear'}`);
      if (row === null) return null;
      row = { ...row, stoppedByUserAt: at };
      return row;
    },
  };
  const pauseNextRead = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    pause = { promise, release };
    return release;
  };
  return { store, log, current: () => row, pauseNextRead };
}

function relayService(targetPort: number, overrides: Partial<SandboxServiceInfo> = {}): SandboxServiceInfo {
  const spec = buildPreviewRelaySpec({ targetPort });
  return { name: spec.name, command: spec.command, args: spec.args, status: 'running', pid: 42, ...overrides };
}

function handleFor(log: string[], relay: SandboxServiceInfo | null): SandboxHandle {
  return {
    sandboxId: 'sbx',
    spriteInstanceId: INSTANCE,
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => { throw new Error('unused'); },
    listStreams: async () => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
    services: {
      create: async (args) => { log.push(`create:${args.name}`); },
      list: async () => [],
      get: async () => relay,
      start: async (name) => { log.push(`start:${name}`); },
      stop: async (name) => { log.push(`stop:${name}`); },
      remove: async (name) => { log.push(`remove:${name}`); },
    },
    urlInfo: async () => ({ url: null, auth: 'unknown' }),
    setUrlAuth: async () => {},
    powerState: async () => 'running',
  };
}

/** A real per-holder mutex, so "the other tier holds it" is exact. */
function serialLock(): DevPreviewLock {
  const held = new Map<string, Promise<unknown>>();
  return async (holder, fn) => {
    const key = `${holder.kind}:${holder.id}`;
    const previous = held.get(key) ?? Promise.resolve();
    let release!: () => void;
    held.set(key, new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    try {
      return { outcome: 'acquired', result: await fn() };
    } finally {
      release();
    }
  };
}

/** A lock that is always taken by someone else — the exhausted-budget case. */
const alwaysBusy: DevPreviewLock = async () => ({ outcome: 'busy' });

function row(targetPort: number, overrides: Partial<DevPreviewRecord> = {}): DevPreviewRecord {
  return {
    id: 'r1',
    spriteInstanceId: INSTANCE,
    sandboxId: 'sbx',
    targetPort,
    relayServiceName: targetPort === 8080 ? null : PREVIEW_RELAY_SERVICE_NAME,
    detectedAt: new Date('2026-09-07T11:00:00.000Z'),
    stoppedByUserAt: null,
    ...overrides,
  };
}

describe('the web tier and the detector, serialized per holder', () => {
  it('THE REPORTED BUG, forced rather than hoped for: a detection frame paused mid-read cannot have a user stop land inside its critical section', async () => {
    const calls: string[] = [];
    const { store, log, current, pauseNextRead } = sharedStore(row(5173, { relayServiceName: null }));
    const lock = serialLock();
    const detector = createDevPreviewDetector({
      holder: HOLDER,
      handle: handleFor(calls, null),
      store,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      probeRuntime: async () => 'node',
      lock,
    });

    // The detector enters its section and BLOCKS inside the read.
    const release = pauseNextRead();
    const frame = detector.onFrame({ type: 'port_opened', port: 5173, pid: 3 });
    // Wait until the detector has actually ENTERED its section, otherwise the
    // click would simply happen first and prove nothing.
    for (let i = 0; i < 100 && !log.includes('read'); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(log).toContain('read');

    // The user clicks Stop while the detector is mid-section. Serialized, this
    // cannot begin until the frame is done; unserialized it writes immediately,
    // landing between the detector's read and its write.
    const action = applyDevPreviewUserAction({
      holder: HOLDER,
      action: 'stop',
      ...ACTOR,
      deps: { previewStore: store, attach: async () => handleFor(calls, relayService(5173)), readListeners: async () => [{ port: 5173, pid: 3 }], canRunCode: async () => ({ ok: true }), lock, now: () => NOW },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const [, actionResult] = await Promise.all([frame, action]);

    assert({ given: 'a stop issued while a frame held the section', should: 'record the stop', actual: actionResult.ok, expected: true });
    assert({ given: 'the stop', should: 'survive — the row ends switched off', actual: current()?.stoppedByUserAt, expected: NOW });

    // ATOMICITY, and this is the assertion that discriminates. Unserialized,
    // the click lands between the detector's read and its write, so the
    // compare-and-set REFUSES that write — the outcome is still correct (that
    // is row-first plus the CAS doing their job) but the frame's work is
    // thrown away, and nothing guarantees another frame will come to redo it.
    // Serialized, the detector's section completes as a unit and no write is
    // ever refused.
    // THE DISCRIMINATING ASSERTION. Unserialized, the click lands between the
    // frame's read and its write, the compare-and-set refuses that write, and
    // the frame's work is simply LOST — no row, no relay, and nothing
    // guarantees another frame will ever come to redo it (a dev server that
    // starts and then sits quiet emits no more). Serialized, the frame
    // completes as a unit and the click then acts on what it left behind.
    assert({
      given: 'a click forced into the middle of a detection frame',
      should: 'let the frame finish its own section rather than lose its work',
      actual: { recordedRow: log.some((entry) => entry.startsWith('upsert:')), refused: log.includes('upsert-refused') },
      expected: { recordedRow: true, refused: false },
    });
    assert({
      given: 'the click that followed it',
      should: 'stop the relay the frame had just started — no orphan, no lost intent',
      actual: calls,
      expected: [`create:${PREVIEW_RELAY_SERVICE_NAME}`, `stop:${PREVIEW_RELAY_SERVICE_NAME}`],
    });
  });

  it('a user action that cannot take the lock still records the intent and says so', async () => {
    const calls: string[] = [];
    const { store, current } = sharedStore(row(5173));
    const result = await applyDevPreviewUserAction({
      holder: HOLDER,
      action: 'stop',
      ...ACTOR,
      deps: { previewStore: store, attach: async () => handleFor(calls, relayService(5173)), readListeners: async () => null, canRunCode: async () => ({ ok: true }), lock: alwaysBusy, now: () => NOW },
    });
    assert({ given: 'a contended lock', should: 'record the intent and report the deferral honestly', actual: result, expected: { ok: true, applied: null, lockContended: true } });
    assert({ given: 'the deferral', should: 'still have switched the preview off', actual: current()?.stoppedByUserAt, expected: NOW });
    assert({ given: 'the deferral', should: 'touch no service', actual: calls, expected: [] });
  });

  it('a detection frame that cannot take the lock is DEFERRED, not dropped silently, and the next frame does the work', async () => {
    const calls: string[] = [];
    const { store } = sharedStore(null);
    const logged: string[] = [];
    let busy = true;
    const detector = createDevPreviewDetector({
      holder: HOLDER,
      handle: handleFor(calls, null),
      store,
      now: () => NOW,
      log: { info: (m, c) => logged.push(`${m}:${JSON.stringify(c ?? {})}`), warn: () => {}, error: () => {} },
      probeRuntime: async () => 'node',
      lock: async (holder, fn) => (busy ? { outcome: 'busy' } : { outcome: 'acquired', result: await fn() }),
    });

    await detector.onFrame({ type: 'port_opened', port: 5173, pid: 3 });
    assert({ given: 'a contended frame', should: 'touch nothing', actual: calls, expected: [] });
    expect(logged.some((l) => l.includes('deferred'))).toBe(true);

    busy = false;
    await detector.onFrame({ type: 'port_opened', port: 5173, pid: 3 });
    assert({ given: 'the next frame with the lock free', should: 'do the work it deferred', actual: calls, expected: [`create:${PREVIEW_RELAY_SERVICE_NAME}`] });
  });

  it('a stop-relay planned before a RESUME stops nothing once the resume has landed', async () => {
    const calls: string[] = [];
    const { store } = sharedStore(row(5173, { stoppedByUserAt: NOW }));
    // The plan is made while the stop still stands...
    const plan = planDevServerService({
      liveInstanceId: INSTANCE,
      sandboxId: 'sbx',
      holder: HOLDER,
      row: row(5173, { stoppedByUserAt: NOW }),
      detected: null,
      relay: relayService(5173),
      listeners: [{ port: 5173, pid: 3 }],
      now: NOW,
    });
    assert({ given: 'a stopped row with a live relay', should: 'plan stop-relay', actual: plan.action, expected: 'stop-relay' });

    // ...the user resumes...
    await store.setStoppedByUser(HOLDER, null);

    // ...and the stale plan is carried out: it must stop nothing.
    const { applyDevServerServicePlan } = await import('../dev-preview-effects');
    const applied = await applyDevServerServicePlan({ plan, services: handleFor(calls, relayService(5173)).services, store });
    assert({ given: 'a stop-relay whose stop was cleared', should: 'stop nothing and say why', actual: { applied, calls }, expected: { applied: { action: 'skipped', reason: 'resumed', mutated: 'none' }, calls: [] } });
  });

  it('a degraded lock pool never breaks a click: the intent lands and nothing throws', async () => {
    const { store, current } = sharedStore(row(5173));
    const degraded: DevPreviewLock = vi.fn(async () => ({ outcome: 'busy' }));
    const result = await applyDevPreviewUserAction({
      holder: HOLDER,
      action: 'resume',
      ...ACTOR,
      deps: { previewStore: store, attach: async () => { throw new Error('never reached'); }, readListeners: async () => null, canRunCode: async () => ({ ok: true }), lock: degraded, now: () => NOW },
    });
    assert({ given: 'a lock pool that cannot serve', should: 'still clear the stop intent', actual: { ok: result.ok, stopped: current()?.stoppedByUserAt }, expected: { ok: true, stopped: null } });
  });
});
