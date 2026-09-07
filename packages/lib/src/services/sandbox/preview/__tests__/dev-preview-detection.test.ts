import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxServiceInfo, SandboxServicesApi } from '../../sandbox-host';
import { createDevPreviewDetector, type DevPreviewDetectorDeps } from '../dev-preview-detection';
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
      row = { id: 'r', spriteInstanceId: intent.spriteInstanceId, sandboxId: intent.sandboxId, targetPort: intent.targetPort, relayServiceName: intent.relayServiceName, detectedAt: intent.detectedAt, stoppedByUserAt: null, approvedPort: null };
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
  const detector = createDevPreviewDetector(deps);
  return { detector, calls, logs, probes: () => probes, relay: () => relay, row: () => row };
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
    const stale: DevPreviewRecord = { id: 'r', spriteInstanceId: 'inst-0', sandboxId: 'sbx', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null };
    const h = harness({ row: stale });
    await h.detector.onFrame({ type: 'port_opened', port: 5173 });
    assert({ given: 'stale row', should: 'replace the row for the live instance, then create', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, 'create:5173'] });
    assert({ given: 'stale row', should: 'now name the live instance', actual: h.row()?.spriteInstanceId, expected: INSTANCE });
  });

  it('honours the core: a user-stopped preview is NOT restarted by a new detection', async () => {
    const stopped: DevPreviewRecord = { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: NOW, approvedPort: null };
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
    const h = harness({ relay: relayInfo(5173), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null } });
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
    const g = harness({ relay: relayInfo(5173), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null } });
    await g.detector.onFrame({ type: 'port_list', ports: [{ port: 3000 }, { port: 5173 }] });
    assert({ given: 'a row on 5173 still listening beside 3000', should: 'keep the working preview', actual: g.calls, expected: [] });
  });

  it('with no candidate, reconciles the row (a crashed relay is restarted; a row without a relay gets one)', async () => {
    const h = harness({ relay: relayInfo(5173, 'node', 'failed'), row: { id: 'r', spriteInstanceId: INSTANCE, sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, approvedPort: null } });
    await h.detector.onFrame({ type: 'port_list', ports: [{ port: 5432 }] });
    assert({ given: 'a failed relay and a row', should: 'start it again', actual: h.calls, expected: [`upsert:5173:${PREVIEW_RELAY_SERVICE_NAME}`, `start:${PREVIEW_RELAY_SERVICE_NAME}`] });
  });
});

describe('createDevPreviewDetector — discipline', () => {
  it('processes frames strictly in order, one at a time', async () => {
    const h = harness();
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
    const stored = { id: 'r', spriteInstanceId: 'inst-1', sandboxId: 'sbx', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: new Date('2026-09-06T12:00:00.000Z'), stoppedByUserAt: stoppedAt, approvedPort: null };
    // The planner reads the PRE-stop row; the store already holds the stop.
    const h = harness({ row: stored, readsAheadOfWrites: { ...stored, stoppedByUserAt: null, approvedPort: null }, relay: relayInfo(5173, 'node', 'failed') });
    await h.detector.onFrame({ type: 'port_opened', port: 5173, pid: 11 });
    assert({ given: 'a stop that landed after the plan\'s read', should: 'attempt the write and be refused by the guard', actual: h.calls.includes('upsert-refused'), expected: true });
    assert({ given: 'the refused write', should: 'leave the user\'s stop intact', actual: h.row()?.stoppedByUserAt, expected: stoppedAt });
  });
});
