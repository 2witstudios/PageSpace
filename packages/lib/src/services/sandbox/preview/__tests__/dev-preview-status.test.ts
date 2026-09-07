/**
 * The UI's read model and the two user actions — built from the core's
 * answers, never from a probe.
 */
import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { SPRITE_SANDBOX_CAPABILITIES, type SandboxHandle, type SandboxServiceInfo } from '../../sandbox-host';
import type { DevPreviewHolderRef, DevPreviewRow } from '../dev-preview-core';
import { HTTP_PORT_BUSY_MESSAGE, describeServiceState } from '../dev-preview-core';
import type { DevPreviewRecord, DevPreviewStore } from '../dev-preview-store';
import {
  SANDBOX_ABSENT_MESSAGE,
  applyDevPreviewUserAction,
  buildDevPreviewStatus,
  describeSlotMessage,
  gatherDevPreviewStatus,
  type DevPreviewStatusDeps,
  type DevPreviewUserActionDeps,
} from '../dev-preview-status';
import { PREVIEW_RELAY_SERVICE_NAME, SPRITE_HTTP_PORT, buildPreviewRelaySpec } from '../preview-relay';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const INSTANCE = 'inst-live';
const ENV: DevPreviewHolderRef = { kind: 'env', id: 'env1' };
const WS: DevPreviewHolderRef = { kind: 'workspace', id: 'ws1' };

function relayService(targetPort: number, overrides: Partial<SandboxServiceInfo> = {}): SandboxServiceInfo {
  const spec = buildPreviewRelaySpec({ targetPort });
  return { name: spec.name, command: spec.command, args: spec.args, status: 'running', pid: 42, ...overrides };
}

function row(targetPort: number, overrides: Partial<DevPreviewRecord> = {}): DevPreviewRecord {
  return {
    id: 'r1',
    spriteInstanceId: INSTANCE,
    sandboxId: 'sbx',
    targetPort,
    relayServiceName: targetPort === SPRITE_HTTP_PORT ? null : PREVIEW_RELAY_SERVICE_NAME,
    detectedAt: new Date('2026-09-06T11:00:00.000Z'),
    stoppedByUserAt: null,
    approvedPort: null,
    ...overrides,
  };
}

function fakeHandle(over: { relay?: SandboxServiceInfo | null; instance?: string | null; calls?: string[] } = {}): SandboxHandle {
  const calls = over.calls ?? [];
  return {
    capabilities: SPRITE_SANDBOX_CAPABILITIES,
    sandboxId: 'sbx',
    spriteInstanceId: over.instance === undefined ? INSTANCE : over.instance,
    exec: async () => { calls.push('exec'); return { exitCode: 1, stdout: '', stderr: '' }; },
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => { throw new Error('unused'); },
    listStreams: async () => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
    services: {
      create: async (args) => { calls.push(`create:${args.name}`); },
      list: async () => [],
      get: async () => { calls.push('services.get'); return over.relay ?? null; },
      start: async (name) => { calls.push(`start:${name}`); },
      stop: async (name) => { calls.push(`stop:${name}`); },
      remove: async (name) => { calls.push(`remove:${name}`); },
    },
    urlInfo: async () => ({ url: null, auth: 'unknown' }),
    setUrlAuth: async () => {},
    powerState: async () => 'running',
  };
}

function fakeStore(initial: DevPreviewRecord | null, calls: string[] = []): DevPreviewStore & { current: () => DevPreviewRecord | null } {
  let current = initial;
  return {
    current: () => current,
    findByHolder: async () => { calls.push('findByHolder'); return current; },
    upsert: async (intent) => {
      calls.push(`upsert:${intent.targetPort}`);
      // The real store refuses when the stored intent has moved since the plan's read.
      if (current !== null && (current.stoppedByUserAt?.getTime() ?? null) !== (intent.basedOnStoppedByUserAt?.getTime() ?? null)) return false;
      const { basedOnStoppedByUserAt: _guard, ...row } = intent;
      current = { id: 'r1', ...row, stoppedByUserAt: null };
      return true;
    },
    approvePort: async (_holder, { port, at }) => {
      calls.push(`approvePort:${port}`);
      // The real store filters the UPDATE on the row's current target, so a
      // port the row no longer names matches nothing.
      if (current === null || current.targetPort !== port) return null;
      current = { ...current, approvedPort: port, stoppedByUserAt: null };
      void at;
      return current;
    },
    setStoppedByUser: async (_holder, at) => {
      calls.push(`setStoppedByUser:${at ? 'stop' : 'clear'}`);
      if (current === null) return null;
      current = { ...current, stoppedByUserAt: at };
      return current;
    },
  };
}

// -----------------------------------------------------------------------------

describe('buildDevPreviewStatus — pure fold', () => {
  const base = { holder: ENV, sandbox: 'attached' as const, liveInstanceId: INSTANCE, detection: 'watching' as const, openPath: '/api/drives/d1/envs/env1/preview/open' };

  it('an absent sandbox is "none" with the absent message, whatever the row says', () => {
    const status = buildDevPreviewStatus({ ...base, sandbox: 'absent', liveInstanceId: null, row: row(5173), relay: null, listeners: null });
    assert({ given: 'no live sprite', should: 'say so and offer nothing', actual: [status.state, status.canOpen, status.canStop, status.canResume, status.slot], expected: [{ status: 'none', message: SANDBOX_ABSENT_MESSAGE }, false, false, false, { known: false }] });
  });

  it('an unreachable sandbox is the CORE\'s instance-unknown with a row (worded once, there) and the core\'s none without', () => {
    const withRow = buildDevPreviewStatus({ ...base, sandbox: 'unreachable', liveInstanceId: null, row: row(5173), relay: null, listeners: null });
    assert({ given: 'unreachable + row', should: 'be instance-unknown, the core\'s copy', actual: withRow.state, expected: describeServiceState({ liveInstanceId: null, row: row(5173), relay: null, listeners: null }) });
    assert({ given: 'unreachable + no row', should: 'be none (nothing was ever detected — not "not running", which would be a guess)', actual: buildDevPreviewStatus({ ...base, sandbox: 'unreachable', liveInstanceId: null, row: null, relay: null, listeners: null }).state, expected: describeServiceState({ liveInstanceId: null, row: null, relay: null, listeners: null }) });
  });

  it('a live relay is openable and stoppable; the slot is reported ONLY when a snapshot is in hand', () => {
    const noSnapshot = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173), listeners: null });
    assert({ given: 'live relay, listeners null', should: 'be live, openable, stoppable, slot unknown', actual: [noSnapshot.state.status, noSnapshot.canOpen, noSnapshot.canStop, noSnapshot.canResume, noSnapshot.slot], expected: ['live', true, true, false, { known: false }] });

    const withSnapshot = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173), listeners: [{ port: 5173, pid: 7 }, { port: SPRITE_HTTP_PORT, pid: 42 }] });
    assert({
      given: 'a snapshot where the relay holds 8080',
      should: 'explain the relay holds it and where it forwards',
      actual: withSnapshot.slot,
      expected: { known: true, holder: 'relay', pid: null, message: `Port 8080 is held by the preview relay, forwarding to your dev server on port 5173.` },
    });
  });

  it('a user process on 8080 is BLOCKED with the core busy message, and the slot names the pid and the way out', () => {
    const status = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173, { status: 'failed', error: 'EADDRINUSE' }), listeners: [{ port: SPRITE_HTTP_PORT, pid: 999 }] });
    assert({ given: 'a foreign 8080 listener', should: 'be blocked (core copy)', actual: [status.state.status, status.state.message, status.canOpen], expected: ['blocked', HTTP_PORT_BUSY_MESSAGE, false] });
    assert({
      given: 'the same snapshot',
      should: 'report the holder with its pid as a FACT (the advice has one home: the core busy message the blocked state carries)',
      actual: status.slot,
      expected: { known: true, holder: 'user-process', pid: 999, message: 'Port 8080 is held by another process in the sandbox (pid 999).' },
    });
    expect(describeSlotMessage({ holder: 'user-process', pid: null, targetPort: 5173 })).toBe('Port 8080 is held by another process in the sandbox.');
    expect(describeSlotMessage({ holder: 'user-process', pid: 999, targetPort: 5173 })).not.toContain('Stop that process');
  });

  it('a free slot with no row is known-free; a DIRECT row\'s 8080 listener is the user\'s own server, never "another process"', () => {
    const status = buildDevPreviewStatus({ ...base, row: null, relay: null, listeners: [] });
    assert({ given: 'empty snapshot, no row', should: 'be none + free', actual: [status.state.status, status.slot], expected: ['none', { known: true, holder: 'none', pid: null, message: 'Port 8080 is free.' }] });
    assert({ given: 'relay copy with an 8080 target', should: 'not mention forwarding', actual: describeSlotMessage({ holder: 'relay', pid: null, targetPort: SPRITE_HTTP_PORT }), expected: 'Port 8080 is held by the preview relay.' });
    const direct = buildDevPreviewStatus({ ...base, row: row(SPRITE_HTTP_PORT), relay: null, listeners: [{ port: SPRITE_HTTP_PORT, pid: 12 }] });
    assert({ given: 'a direct row with its server on 8080', should: 'be live and name the server as the user\'s own', actual: [direct.state.status, direct.slot], expected: ['live', { known: true, holder: 'user-process', pid: 12, message: 'Port 8080 is held by your dev server (pid 12).' }] });
  });

  it('a user-stopped row is resumable, not stoppable, not openable', () => {
    const status = buildDevPreviewStatus({ ...base, row: row(5173, { stoppedByUserAt: NOW }), relay: relayService(5173, { status: 'failed' }), listeners: null });
    assert({ given: 'stopped by user', should: 'offer resume only', actual: [status.state.status, status.canOpen, status.canStop, status.canResume], expected: ['stopped', false, false, true] });
  });

  it('a STALE row (dead instance) offers no action — its stop intent belongs to a dead VM', () => {
    const status = buildDevPreviewStatus({ ...base, row: row(5173, { spriteInstanceId: 'inst-dead', stoppedByUserAt: NOW }), relay: null, listeners: null });
    assert({ given: 'row for another instance', should: 'be stale with nothing actionable', actual: [status.state.status, status.canStop, status.canResume, status.canOpen], expected: ['stale', false, false, false] });
  });

  it('a starting relay is openable (the frame will show it coming up); a down one is not', () => {
    assert({ given: 'starting', should: 'canOpen', actual: buildDevPreviewStatus({ ...base, row: row(3000), relay: relayService(3000, { status: 'starting' }), listeners: null }).canOpen, expected: true });
    assert({
      given: 'down',
      should: 'not canOpen, still canStop, AND canResume — a crashed relay is recoverable in one click instead of waiting for a port frame',
      actual: (() => { const s = buildDevPreviewStatus({ ...base, row: row(3000), relay: relayService(3000, { status: 'failed', error: 'x' }), listeners: null }); return [s.canOpen, s.canStop, s.canResume]; })(),
      expected: [false, true, true],
    });
  });

  /**
   * Restart is offered only where a reconcile can repair it. Not every `down`
   * is the relay's fault: a direct server that stopped listening, and a
   * healthy relay whose TARGET vanished, both plan to `none` — the button
   * would refresh into the identical down state, which reads as a broken
   * control rather than an honest "start your dev server again".
   */
  it('canResume follows the core\'s down.repairable, not the bare down status', () => {
    const repairable = [
      ['crashed relay', row(3000), relayService(3000, { status: 'failed', error: 'x' }), null],
      ['relay never defined', row(3000), null, [{ port: 3000, pid: 7 }]],
      ['relay pointed elsewhere', row(3000), relayService(4000), [{ port: 3000, pid: 7 }]],
      ['leftover relay over a direct row', row(SPRITE_HTTP_PORT), relayService(3000), [{ port: SPRITE_HTTP_PORT, pid: 42 }]],
    ] as const;
    const notRepairable = [
      ['relay up but the dev server exited', row(3000), relayService(3000), [{ port: SPRITE_HTTP_PORT, pid: 42 }]],
      ['direct server stopped listening', row(SPRITE_HTTP_PORT), null, []],
    ] as const;
    for (const [name, r, relay, listeners] of repairable) {
      const s = buildDevPreviewStatus({ ...base, row: r, relay, listeners });
      assert({ given: name, should: 'be a repairable down that offers Restart', actual: [s.state.status, s.state.status === 'down' && s.state.repairable, s.canResume], expected: ['down', true, true] });
    }
    for (const [name, r, relay, listeners] of notRepairable) {
      const s = buildDevPreviewStatus({ ...base, row: r, relay, listeners });
      assert({ given: name, should: 'be down with NO Restart — a reconcile would change nothing', actual: [s.state.status, s.state.status === 'down' && s.state.repairable, s.canResume], expected: ['down', false, false] });
    }
    // …but an explicit user stop is always resumable, whatever the state says.
    const stopped = buildDevPreviewStatus({ ...base, row: row(SPRITE_HTTP_PORT, { stoppedByUserAt: NOW }), relay: null, listeners: [] });
    assert({ given: 'a user-stopped direct row whose server is also gone', should: 'still offer resume — the intent is the users to reverse', actual: stopped.canResume, expected: true });
  });

  it('carries the holder, the open path and detectedAt through', () => {
    const status = buildDevPreviewStatus({ ...base, holder: WS, openPath: '/api/agent-workspaces/ws1/preview/open', row: row(5173), relay: relayService(5173), listeners: null });
    assert({ given: 'a workspace reader', should: 'echo holder, openPath, detectedAt', actual: [status.holder, status.openPath, status.detectedAt], expected: [WS, '/api/agent-workspaces/ws1/preview/open', new Date('2026-09-06T11:00:00.000Z')] });
  });
});

// -----------------------------------------------------------------------------

function statusDeps(over: Partial<DevPreviewStatusDeps> & { calls?: string[] } = {}): DevPreviewStatusDeps & { calls: string[] } {
  const calls = over.calls ?? [];
  const track = <T,>(name: string, value: T) => { calls.push(name); return value; };
  return {
    calls,
    findSession: async () => track('findSession', { id: 'ws1', ownerId: 'owner', driveId: 'd1', envId: null, sandboxId: 'sbx-ws', spriteTornDownAt: null, endedAt: null }),
    findEnv: async () => track('findEnv', { id: 'env1', driveId: 'd1', substrate: 'sprite' as const, sandboxId: 'sbx-env', spriteTornDownAt: null }),
    resolveDriveMembership: async () => track('membership', 'member' as const),
    resolveDrivePayer: async () => track('payer', { payerId: 'owner' }),
    attach: async () => track('attach', fakeHandle({ relay: relayService(5173), calls })),
    previewStore: fakeStore(row(5173), calls),
    readListeners: async () => track('readListeners', { detection: 'watching', listeners: [{ port: 5173, pid: 7 }, { port: SPRITE_HTTP_PORT, pid: 42 }] }),
    ...over,
  };
}

describe('gatherDevPreviewStatus — authorize, attach, fold; never a probe', () => {
  it('an env member gets the live state with the slot explained from the realtime snapshot, and no exec ever runs', async () => {
    const d = statusDeps();
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'member + live relay + snapshot', should: 'be live with a known relay-held slot', actual: [result.status.state.status, result.status.slot.known && result.status.slot.holder, result.status.sandbox, result.status.openPath], expected: ['live', 'relay', 'attached', '/api/drives/d1/envs/env1/preview/open'] });
    assert({ given: 'the gather', should: 'never exec', actual: d.calls.includes('exec'), expected: false });
    assert({ given: 'the gather', should: 'read the services API once', actual: d.calls.filter((c) => c === 'services.get').length, expected: 1 });
  });

  it('a refused user gets the decider reason and NO control-plane read', async () => {
    const d = statusDeps({ resolveDriveMembership: async () => 'none' });
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    assert({ given: 'no membership', should: 'refuse with the reason', actual: result, expected: { ok: false, reason: 'not-authorized', detail: 'drive_access_denied' } });
    assert({ given: 'a refusal', should: 'not attach or ask realtime', actual: d.calls.some((c) => c === 'attach' || c === 'readListeners' || c === 'services.get'), expected: false });
  });

  it('an env-bound SESSION reader authorizes as the session, reads the ENV holder, and gets the SESSION open path', async () => {
    const d = statusDeps({
      findSession: async () => ({ id: 'ws1', ownerId: 'owner', driveId: 'd1', envId: 'env1', sandboxId: null, spriteTornDownAt: null, endedAt: null }),
    });
    const result = await gatherDevPreviewStatus({ authorizeAs: WS, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'env-bound session', should: 'be the env preview reached via the session route', actual: [result.status.holder, result.status.openPath, result.status.state.status], expected: [ENV, '/api/agent-workspaces/ws1/preview/open', 'live'] });
  });

  it('a holder with no live sprite is absent: the row is read (so a stale one still surfaces as none) and nothing is attached', async () => {
    const d = statusDeps({ findEnv: async () => ({ id: 'env1', driveId: 'd1', substrate: 'sprite', sandboxId: null, spriteTornDownAt: null }) });
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'no sandbox', should: 'be absent/none', actual: [result.status.sandbox, result.status.state.status, result.status.canStop], expected: ['absent', 'none', false] });
    assert({ given: 'no sandbox', should: 'not attach', actual: d.calls.includes('attach'), expected: false });
  });

  it('a sprite the platform cannot attach is unreachable, folded without listeners', async () => {
    const d = statusDeps({ attach: async () => null });
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'attach → null', should: 'be unreachable / instance-unknown, slot unknown', actual: [result.status.sandbox, result.status.state.status, result.status.slot], expected: ['unreachable', 'instance-unknown', { known: false }] });
  });

  it('a null snapshot from realtime renders the LAST-KNOWN state honestly (relay status carries it) with the slot unknown', async () => {
    const d = statusDeps({ readListeners: async () => ({ detection: 'unavailable', listeners: null }) });
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'no snapshot', should: 'still be live, slot unknown', actual: [result.status.state.status, result.status.slot], expected: ['live', { known: false }] });
  });
});

// -----------------------------------------------------------------------------

const ACTOR = { userId: 'u1', wakeSubject: { driveId: 'd1', ownerId: 'owner' } };

function actionDeps(over: Partial<DevPreviewUserActionDeps> & { calls?: string[]; store?: ReturnType<typeof fakeStore> } = {}) {
  const calls = over.calls ?? [];
  const store = over.store ?? fakeStore(row(5173), calls);
  const deps: DevPreviewUserActionDeps = {
    previewStore: store,
    attach: async () => fakeHandle({ relay: relayService(5173), calls }),
    readListeners: async () => ({ detection: 'unavailable', listeners: null }),
    canRunCode: async (input) => { calls.push(`canRunCode:${input.userId}:${input.driveId}:${input.ownerId}`); return { ok: true }; },
    now: () => NOW,
    ...over,
  };
  return { deps, calls, store };
}

describe('applyDevPreviewUserAction — intent first, then ONE reconcile through the core', () => {
  it('STOP records the intent and the core stops the live relay', async () => {
    const { deps, calls, store } = actionDeps();
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps });
    assert({ given: 'a live relay', should: 'stop it', actual: result, expected: { ok: true, applied: { action: 'stop-relay', relayServiceName: PREVIEW_RELAY_SERVICE_NAME } } });
    assert({ given: 'the stop', should: 'write the intent BEFORE planning', actual: calls.indexOf('setStoppedByUser:stop') < calls.indexOf('services.get'), expected: true });
    assert({ given: 'the stop', should: 'leave the row stopped at now', actual: store.current()?.stoppedByUserAt, expected: NOW });
    assert({ given: 'the stop', should: 'never exec', actual: calls.includes('exec'), expected: false });
  });

  it('RESUME clears the intent and the core restarts the defined-but-stopped relay', async () => {
    const trackedCalls: string[] = [];
    const { deps, store } = actionDeps({
      store: fakeStore(row(5173, { stoppedByUserAt: NOW })),
      attach: async () => fakeHandle({ relay: relayService(5173, { status: 'failed', error: 'exited with code 143' }), calls: trackedCalls }),
      // A CURRENT snapshot: the dev server is up and 8080 is free, so the
      // relay may honestly be started (see the slot-unknown case below).
      readListeners: async () => ({ detection: 'watching', listeners: [{ port: 5173, pid: 7 }] }),
    });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps });
    assert({ given: 'a stopped relay', should: 'start it and re-record the row', actual: result, expected: { ok: true, applied: { action: 'start-relay', via: 'start', targetPort: 5173, recorded: true } } });
    assert({ given: 'the resume', should: 'call services.start', actual: trackedCalls.includes(`start:${PREVIEW_RELAY_SERVICE_NAME}`), expected: true });
    assert({ given: 'the resume', should: 'leave stoppedByUserAt cleared', actual: store.current()?.stoppedByUserAt, expected: null });
  });

  it('RESUME with NO current snapshot refuses to start a relay blind — the intent is still cleared, so the detector\'s next frame starts it against real listeners', async () => {
    const trackedCalls: string[] = [];
    const store = fakeStore(row(5173, { stoppedByUserAt: NOW }));
    const { deps } = actionDeps({
      store,
      attach: async () => fakeHandle({ relay: relayService(5173, { status: 'failed' }), calls: trackedCalls }),
      readListeners: async () => ({ detection: 'unavailable', listeners: null }),
    });
    assert({ given: 'no ports/watch snapshot', should: 'refuse rather than read unknown as "8080 is free"', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps }), expected: { ok: false, reason: 'slot-unknown' } });
    assert({ given: 'the refusal', should: 'still have cleared the stop — the user\'s ON stands', actual: store.current()?.stoppedByUserAt, expected: null });
    assert({ given: 'the refusal', should: 'touch no service', actual: trackedCalls.some((c) => c.startsWith('start:') || c.startsWith('create:')), expected: false });
  });

  it('a DIRECT (8080) resume needs no snapshot — there is no relay to place', async () => {
    const { deps } = actionDeps({ store: fakeStore(row(SPRITE_HTTP_PORT, { stoppedByUserAt: NOW })), attach: async () => fakeHandle({ relay: null }), readListeners: async () => ({ detection: 'unavailable', listeners: null }) });
    assert({ given: 'a direct row and no snapshot', should: 'converge without refusing', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps }), expected: { ok: true, applied: { action: 'none', reason: 'already-direct', staleRowIgnored: false } } });
  });

  it('RESUME against a slot a user process has since taken is REFUSED by the core (with the snapshot), not planned', async () => {
    const trackedCalls: string[] = [];
    const { deps } = actionDeps({
      store: fakeStore(row(5173, { stoppedByUserAt: NOW })),
      attach: async () => fakeHandle({ relay: relayService(5173, { status: 'failed' }), calls: trackedCalls }),
      readListeners: async () => ({ detection: 'watching', listeners: [{ port: SPRITE_HTTP_PORT, pid: 999 }] }),
    });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps });
    assert({ given: 'foreign 8080 listener', should: 'refuse http-port-busy', actual: result, expected: { ok: true, applied: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 } } });
    assert({ given: 'the refusal', should: 'touch no service', actual: trackedCalls.some((c) => c.startsWith('start:') || c.startsWith('create:')), expected: false });
  });

  it('RESUME asks the wake gate on the PAYER before touching anything; a refusal writes nothing and starts nothing (mutation-proof: drop the gate and this goes red)', async () => {
    const trackedCalls: string[] = [];
    const store = fakeStore(row(5173, { stoppedByUserAt: NOW }), trackedCalls);
    const { deps } = actionDeps({
      store,
      calls: trackedCalls,
      attach: async () => fakeHandle({ relay: relayService(5173, { status: 'failed' }), calls: trackedCalls }),
      canRunCode: async (input) => { trackedCalls.push(`canRunCode:${input.userId}:${input.driveId}:${input.ownerId}`); return { ok: false, reason: 'no_capability' as never }; },
    });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps });
    assert({ given: 'a payer who may not run code', should: 'refuse the resume with the gate reason', actual: result, expected: { ok: false, reason: 'wake-not-allowed', detail: 'no_capability' } });
    assert({ given: 'the refusal', should: 'consult the gate on the PAYER (driveId + ownerId), not the actor as payer', actual: trackedCalls[0], expected: 'canRunCode:u1:d1:owner' });
    assert({ given: 'the refusal', should: 'leave the stop intent in place', actual: store.current()?.stoppedByUserAt, expected: NOW });
    assert({ given: 'the refusal', should: 'write nothing, attach nothing, start nothing', actual: trackedCalls.filter((c) => !c.startsWith('canRunCode')), expected: [] });
  });

  it('STOP is never gated — stopping compute needs no spend permission', async () => {
    const { deps, calls } = actionDeps({ canRunCode: async () => { calls.push('canRunCode'); return { ok: false, reason: 'no_capability' as never }; } });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps });
    assert({ given: 'a denied payer stopping', should: 'still stop', actual: result.ok, expected: true });
    assert({ given: 'a stop', should: 'not consult the gate', actual: calls.includes('canRunCode'), expected: false });
  });

  it('a holder with no row is no-preview and nothing is attached', async () => {
    const trackedCalls: string[] = [];
    const { deps } = actionDeps({ store: fakeStore(null), attach: async () => { trackedCalls.push('attach'); return null; } });
    assert({ given: 'no row', should: 'be no-preview', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps }), expected: { ok: false, reason: 'no-preview' } });
    assert({ given: 'no row', should: 'not attach', actual: trackedCalls, expected: [] });
  });

  it('a sprite the platform cannot attach still records the intent (applied: null) — the planner honours it later', async () => {
    const { deps, store } = actionDeps({ attach: async () => null });
    assert({ given: 'attach → null', should: 'record and report no effect', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps }), expected: { ok: true, applied: null } });
    assert({ given: 'attach → null', should: 'still have written the intent', actual: store.current()?.stoppedByUserAt, expected: NOW });
  });

  it('a row for a DEAD instance is ignored by the core: the intent is recorded and the plan is nothing-detected', async () => {
    const { deps } = actionDeps({ store: fakeStore(row(5173, { spriteInstanceId: 'inst-dead' })) });
    assert({ given: 'stale row', should: 'plan nothing', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps }), expected: { ok: true, applied: { action: 'none', reason: 'nothing-detected', staleRowIgnored: true } } });
  });

  it('a direct (8080) row: stop records intent with nothing to stop; resume records direct again', async () => {
    const stopCalls: string[] = [];
    const stop = actionDeps({ store: fakeStore(row(SPRITE_HTTP_PORT)), attach: async () => fakeHandle({ relay: null, calls: stopCalls }) });
    assert({ given: 'direct row, stop', should: 'be user-stopped with no service call', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'stop' }, ...ACTOR, deps: stop.deps }), expected: { ok: true, applied: { action: 'none', reason: 'user-stopped', staleRowIgnored: false } } });
    const resume = actionDeps({ store: fakeStore(row(SPRITE_HTTP_PORT, { stoppedByUserAt: NOW })), attach: async () => fakeHandle({ relay: null }) });
    assert({ given: 'direct row, resume', should: 'converge as already-direct', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'resume' }, ...ACTOR, deps: resume.deps }), expected: { ok: true, applied: { action: 'none', reason: 'already-direct', staleRowIgnored: false } } });
  });
});

describe('approve — one explicit act, bound to the port the user was shown', () => {
  function pending(overrides: Partial<DevPreviewUserActionDeps> = {}) {
    const calls: string[] = [];
    const store = fakeStore(row(9000, { relayServiceName: null }), calls);
    const { deps } = actionDeps({
      calls,
      store,
      attach: async () => fakeHandle({ relay: null, calls }),
      readListeners: async () => ({ detection: 'watching', listeners: [{ port: 9000, pid: 7 }] }),
      ...overrides,
    });
    return { deps, calls, store };
  }

  it('records the consent, clears any stop, and the SAME call reconciles the relay up', async () => {
    const { deps, calls, store } = pending();
    const result = await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'approve', port: 9000 }, ...ACTOR, deps });
    assert({ given: 'an approve for the detected port', should: 'create the relay', actual: result, expected: { ok: true, applied: { action: 'start-relay', via: 'create', targetPort: 9000, recorded: true } } });
    assert({ given: 'the approve', should: 'write the consent BEFORE planning', actual: calls.indexOf('approvePort:9000') < calls.indexOf('services.get'), expected: true });
    assert({ given: 'the approve', should: 'leave the row approved', actual: store.current()?.approvedPort, expected: 9000 });
  });

  it('REFUSES a port the row no longer targets, and writes nothing — the echo is what binds the click to the screen', async () => {
    const calls: string[] = [];
    const store = fakeStore(row(9001, { relayServiceName: null }), calls);
    const { deps } = actionDeps({ calls, store, attach: async () => fakeHandle({ relay: null, calls }) });
    assert({ given: 'a click for 9000 while the server moved to 9001', should: 'be port-changed', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'approve', port: 9000 }, ...ACTOR, deps }), expected: { ok: false, reason: 'port-changed' } });
    assert({ given: 'a refused approve', should: 'approve nothing', actual: store.current()?.approvedPort, expected: null });
    assert({ given: 'a refused approve', should: 'never reach the sprite', actual: calls.includes('services.get'), expected: false });
  });

  it('a holder with no row at all is no-preview, not port-changed', async () => {
    const { deps } = actionDeps({ store: fakeStore(null) });
    assert({ given: 'no row', should: 'be no-preview', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'approve', port: 9000 }, ...ACTOR, deps }), expected: { ok: false, reason: 'no-preview' } });
  });

  it('is gated by the wake gate exactly as a resume is — sharing a port is asking for compute', async () => {
    const { deps, store } = pending({ canRunCode: async () => ({ ok: false as const, reason: 'tier_ineligible' }) });
    assert({ given: 'a payer that may not run code', should: 'refuse', actual: await applyDevPreviewUserAction({ holder: ENV, action: { kind: 'approve', port: 9000 }, ...ACTOR, deps }), expected: { ok: false, reason: 'wake-not-allowed', detail: 'tier_ineligible' } });
    assert({ given: 'a refused wake gate', should: 'write no consent', actual: store.current()?.approvedPort, expected: null });
  });

  it('the status offers the decision only where it can be taken: needs-approval, on this instance', () => {
    const base = { holder: ENV, sandbox: 'attached' as const, detection: 'watching' as const, openPath: '/o' };
    const waiting = buildDevPreviewStatus({ ...base, liveInstanceId: INSTANCE, row: row(9000, { relayServiceName: null }), relay: null, listeners: null });
    assert({ given: 'an unshared 9000', should: 'offer approval, naming the port, and offer no open', actual: [waiting.state.status, waiting.canApprove, waiting.pendingApprovalPort, waiting.canOpen], expected: ['needs-approval', true, 9000, false] });
    const live = buildDevPreviewStatus({ ...base, liveInstanceId: INSTANCE, row: row(5173), relay: relayService(5173), listeners: null });
    assert({ given: 'a live known-port preview', should: 'have nothing to approve', actual: [live.canApprove, live.pendingApprovalPort], expected: [false, null] });
    const stale = buildDevPreviewStatus({ ...base, liveInstanceId: 'other-instance', row: row(9000, { relayServiceName: null }), relay: null, listeners: null });
    assert({ given: 'a row from a dead VM', should: 'offer nothing to approve', actual: stale.canApprove, expected: false });
  });
});
