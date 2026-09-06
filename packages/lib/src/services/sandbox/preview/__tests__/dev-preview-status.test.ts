/**
 * The UI's read model and the two user actions — built from the core's
 * answers, never from a probe.
 */
import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxHandle, SandboxServiceInfo } from '../../sandbox-host';
import type { DevPreviewHolderRef, DevPreviewRow } from '../dev-preview-core';
import { HTTP_PORT_BUSY_MESSAGE } from '../dev-preview-core';
import type { DevPreviewRecord, DevPreviewStore } from '../dev-preview-store';
import {
  SANDBOX_ABSENT_MESSAGE,
  SANDBOX_UNREACHABLE_MESSAGE,
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
    ...overrides,
  };
}

function fakeHandle(over: { relay?: SandboxServiceInfo | null; instance?: string | null; calls?: string[] } = {}): SandboxHandle {
  const calls = over.calls ?? [];
  return {
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
      current = { id: 'r1', ...intent, stoppedByUserAt: null };
    },
    setStoppedByUser: async (_holder, at) => {
      calls.push(`setStoppedByUser:${at ? 'stop' : 'clear'}`);
      if (current === null) return false;
      current = { ...current, stoppedByUserAt: at };
      return true;
    },
  };
}

// -----------------------------------------------------------------------------

describe('buildDevPreviewStatus — pure fold', () => {
  const base = { holder: ENV, sandbox: 'attached' as const, liveInstanceId: INSTANCE, openPath: '/api/drives/d1/envs/env1/preview/open' };

  it('an absent sandbox is "none" with the absent message, whatever the row says', () => {
    const status = buildDevPreviewStatus({ ...base, sandbox: 'absent', liveInstanceId: null, row: row(5173), relay: null, listeners: null });
    assert({ given: 'no live sprite', should: 'say so and offer nothing', actual: [status.state, status.canOpen, status.canStop, status.canResume, status.slot], expected: [{ status: 'none', message: SANDBOX_ABSENT_MESSAGE }, false, false, false, { known: false }] });
  });

  it('an unreachable sandbox is instance-unknown with a row and none without', () => {
    assert({ given: 'unreachable + row', should: 'be instance-unknown with the unreachable message', actual: buildDevPreviewStatus({ ...base, sandbox: 'unreachable', liveInstanceId: null, row: row(5173), relay: null, listeners: null }).state, expected: { status: 'instance-unknown', message: SANDBOX_UNREACHABLE_MESSAGE } });
    assert({ given: 'unreachable + no row', should: 'be none', actual: buildDevPreviewStatus({ ...base, sandbox: 'unreachable', liveInstanceId: null, row: null, relay: null, listeners: null }).state.status, expected: 'none' });
  });

  it('a live relay is openable and stoppable; the slot is reported ONLY when a snapshot is in hand', () => {
    const noSnapshot = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173), listeners: null });
    assert({ given: 'live relay, listeners null', should: 'be live, openable, stoppable, slot unknown', actual: [noSnapshot.state.status, noSnapshot.canOpen, noSnapshot.canStop, noSnapshot.canResume, noSnapshot.slot], expected: ['live', true, true, false, { known: false }] });

    const withSnapshot = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173), listeners: [{ port: 5173, pid: 7 }, { port: SPRITE_HTTP_PORT, pid: 42 }] });
    assert({
      given: 'a snapshot where the relay holds 8080',
      should: 'explain the relay holds it and where it forwards',
      actual: withSnapshot.slot,
      expected: { known: true, free: false, holder: 'relay', pid: null, message: `Port 8080 is held by the preview relay, forwarding to your dev server on port 5173.` },
    });
  });

  it('a user process on 8080 is BLOCKED with the core busy message, and the slot names the pid and the way out', () => {
    const status = buildDevPreviewStatus({ ...base, row: row(5173), relay: relayService(5173, { status: 'failed', error: 'EADDRINUSE' }), listeners: [{ port: SPRITE_HTTP_PORT, pid: 999 }] });
    assert({ given: 'a foreign 8080 listener', should: 'be blocked (core copy)', actual: [status.state.status, status.state.message, status.canOpen], expected: ['blocked', HTTP_PORT_BUSY_MESSAGE, false] });
    assert({
      given: 'the same snapshot',
      should: 'report the holder with its pid and both remedies',
      actual: status.slot,
      expected: { known: true, free: false, holder: 'user-process', pid: 999, message: describeSlotMessage({ holder: 'user-process', pid: 999, targetPort: 5173 }) },
    });
    expect(describeSlotMessage({ holder: 'user-process', pid: 999, targetPort: 5173 })).toContain('pid 999');
    expect(describeSlotMessage({ holder: 'user-process', pid: 999, targetPort: 5173 })).toContain('run your dev server on port 8080');
    expect(describeSlotMessage({ holder: 'user-process', pid: null, targetPort: 5173 })).not.toContain('pid');
  });

  it('a free slot with no row is known-free', () => {
    const status = buildDevPreviewStatus({ ...base, row: null, relay: null, listeners: [] });
    assert({ given: 'empty snapshot, no row', should: 'be none + free', actual: [status.state.status, status.slot], expected: ['none', { known: true, free: true, holder: 'none', pid: null, message: 'Port 8080 is free.' }] });
    assert({ given: 'relay copy with an 8080 target', should: 'not mention forwarding', actual: describeSlotMessage({ holder: 'relay', pid: null, targetPort: SPRITE_HTTP_PORT }), expected: 'Port 8080 is held by the preview relay.' });
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
    assert({ given: 'down', should: 'not canOpen but still canStop', actual: (() => { const s = buildDevPreviewStatus({ ...base, row: row(3000), relay: relayService(3000, { status: 'failed', error: 'x' }), listeners: null }); return [s.canOpen, s.canStop]; })(), expected: [false, true] });
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
    readListeners: async () => track('readListeners', [{ port: 5173, pid: 7 }, { port: SPRITE_HTTP_PORT, pid: 42 }]),
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
    const d = statusDeps({ readListeners: async () => null });
    const result = await gatherDevPreviewStatus({ authorizeAs: ENV, holder: ENV, userId: 'u1', deps: d });
    if (!result.ok) throw new Error('expected ok');
    assert({ given: 'no snapshot', should: 'still be live, slot unknown', actual: [result.status.state.status, result.status.slot], expected: ['live', { known: false }] });
  });
});

// -----------------------------------------------------------------------------

function actionDeps(over: Partial<DevPreviewUserActionDeps> & { calls?: string[]; store?: ReturnType<typeof fakeStore> } = {}) {
  const calls = over.calls ?? [];
  const store = over.store ?? fakeStore(row(5173), calls);
  const deps: DevPreviewUserActionDeps = {
    previewStore: store,
    attach: async () => fakeHandle({ relay: relayService(5173), calls }),
    readListeners: async () => null,
    now: () => NOW,
    ...over,
  };
  return { deps, calls, store };
}

describe('applyDevPreviewUserAction — intent first, then ONE reconcile through the core', () => {
  it('STOP records the intent and the core stops the live relay', async () => {
    const { deps, calls, store } = actionDeps();
    const result = await applyDevPreviewUserAction({ holder: ENV, action: 'stop', deps });
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
    });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: 'resume', deps });
    assert({ given: 'a stopped relay', should: 'start it and re-record the row', actual: result, expected: { ok: true, applied: { action: 'start-relay', via: 'start', targetPort: 5173 } } });
    assert({ given: 'the resume', should: 'call services.start', actual: trackedCalls.includes(`start:${PREVIEW_RELAY_SERVICE_NAME}`), expected: true });
    assert({ given: 'the resume', should: 'leave stoppedByUserAt cleared', actual: store.current()?.stoppedByUserAt, expected: null });
  });

  it('RESUME against a slot a user process has since taken is REFUSED by the core (with the snapshot), not planned', async () => {
    const trackedCalls: string[] = [];
    const { deps } = actionDeps({
      store: fakeStore(row(5173, { stoppedByUserAt: NOW })),
      attach: async () => fakeHandle({ relay: relayService(5173, { status: 'failed' }), calls: trackedCalls }),
      readListeners: async () => [{ port: SPRITE_HTTP_PORT, pid: 999 }],
    });
    const result = await applyDevPreviewUserAction({ holder: ENV, action: 'resume', deps });
    assert({ given: 'foreign 8080 listener', should: 'refuse http-port-busy', actual: result, expected: { ok: true, applied: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 } } });
    assert({ given: 'the refusal', should: 'touch no service', actual: trackedCalls.some((c) => c.startsWith('start:') || c.startsWith('create:')), expected: false });
  });

  it('a holder with no row is no-preview and nothing is attached', async () => {
    const trackedCalls: string[] = [];
    const { deps } = actionDeps({ store: fakeStore(null), attach: async () => { trackedCalls.push('attach'); return null; } });
    assert({ given: 'no row', should: 'be no-preview', actual: await applyDevPreviewUserAction({ holder: ENV, action: 'stop', deps }), expected: { ok: false, reason: 'no-preview' } });
    assert({ given: 'no row', should: 'not attach', actual: trackedCalls, expected: [] });
  });

  it('a sprite the platform cannot attach still records the intent (applied: null) — the planner honours it later', async () => {
    const { deps, store } = actionDeps({ attach: async () => null });
    assert({ given: 'attach → null', should: 'record and report no effect', actual: await applyDevPreviewUserAction({ holder: ENV, action: 'stop', deps }), expected: { ok: true, applied: null } });
    assert({ given: 'attach → null', should: 'still have written the intent', actual: store.current()?.stoppedByUserAt, expected: NOW });
  });

  it('a row for a DEAD instance is ignored by the core: the intent is recorded and the plan is nothing-detected', async () => {
    const { deps } = actionDeps({ store: fakeStore(row(5173, { spriteInstanceId: 'inst-dead' })) });
    assert({ given: 'stale row', should: 'plan nothing', actual: await applyDevPreviewUserAction({ holder: ENV, action: 'stop', deps }), expected: { ok: true, applied: { action: 'none', reason: 'nothing-detected', staleRowIgnored: true } } });
  });

  it('a direct (8080) row: stop records intent with nothing to stop; resume records direct again', async () => {
    const stopCalls: string[] = [];
    const stop = actionDeps({ store: fakeStore(row(SPRITE_HTTP_PORT)), attach: async () => fakeHandle({ relay: null, calls: stopCalls }) });
    assert({ given: 'direct row, stop', should: 'be user-stopped with no service call', actual: await applyDevPreviewUserAction({ holder: ENV, action: 'stop', deps: stop.deps }), expected: { ok: true, applied: { action: 'none', reason: 'user-stopped', staleRowIgnored: false } } });
    const resume = actionDeps({ store: fakeStore(row(SPRITE_HTTP_PORT, { stoppedByUserAt: NOW })), attach: async () => fakeHandle({ relay: null }) });
    assert({ given: 'direct row, resume', should: 'converge as already-direct', actual: await applyDevPreviewUserAction({ holder: ENV, action: 'resume', deps: resume.deps }), expected: { ok: true, applied: { action: 'none', reason: 'already-direct', staleRowIgnored: false } } });
  });
});
