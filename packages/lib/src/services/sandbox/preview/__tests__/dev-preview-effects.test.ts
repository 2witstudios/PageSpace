import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxServicesApi } from '../../sandbox-host';
import { applyDevServerServicePlan, probeRelayRuntime } from '../dev-preview-effects';
import { buildPreviewRelaySpec, PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';
import type { DevPreviewRowIntent, DevServerServicePlan } from '../dev-preview-core';

const ROW: DevPreviewRowIntent = {
  holder: { kind: 'env', id: 'e1' },
  spriteInstanceId: 'i1',
  sandboxId: 's1',
  targetPort: 5173,
  relayServiceName: PREVIEW_RELAY_SERVICE_NAME,
  detectedAt: new Date('2026-09-06T00:00:00Z'),
  stoppedByUserAt: null,
  basedOnStoppedByUserAt: null,
};

const STOPPED_AT = new Date('2026-09-06T01:00:00Z');

function fakeServices(failing: Partial<Record<keyof SandboxServicesApi, Error>> = {}) {
  const calls: string[] = [];
  const call = (name: keyof SandboxServicesApi, detail = '') => async () => {
    calls.push(detail ? `${name}:${detail}` : name);
    const error = failing[name];
    if (error) throw error;
  };
  const services: SandboxServicesApi = {
    create: async (args) => call('create', `${args.name}:${args.command}:${args.args?.length ?? 0}`)(),
    list: async () => [],
    get: async () => null,
    start: async (name) => call('start', name)(),
    stop: async (name) => call('stop', name)(),
    remove: async (name) => call('remove', name)(),
  };
  return { services, calls };
}

/**
 * `accepts: false` models the store's intent guard refusing the write (a
 * user's stop landed after the plan's read); `stoppedByUserAt` is what the
 * row says NOW, which the `stop-relay` arm re-reads before stopping.
 */
function fakeStore({ accepts = true, stoppedByUserAt = null as Date | null, missing = false } = {}) {
  const written: DevPreviewRowIntent[] = [];
  const reads: string[] = [];
  return {
    store: {
      upsert: async (intent: DevPreviewRowIntent) => { written.push(intent); return accepts; },
      findByHolder: async (holder: { kind: string; id: string }) => { reads.push(`${holder.kind}:${holder.id}`); return missing ? null : { stoppedByUserAt }; },
    },
    written,
    reads,
  };
}

const spec = buildPreviewRelaySpec({ targetPort: 5173 });

describe('applyDevServerServicePlan — obeys the plan, adds nothing', () => {
  it('start-relay via create: creates the exact spec, then upserts the exact row', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    const plan: DevServerServicePlan = { action: 'start-relay', via: 'create', service: spec, row: ROW };
    const applied = await applyDevServerServicePlan({ plan, services, store });
    assert({ given: 'create plan', should: 'create then upsert', actual: { calls, written }, expected: { calls: [`create:${spec.name}:node:${spec.args.length}`], written: [ROW] } });
    assert({ given: 'create plan', should: 'report', actual: applied, expected: { action: 'start-relay', via: 'create', targetPort: 5173, recorded: true } });
  });

  it('start-relay via start: starts by name (no create), then upserts', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    await applyDevServerServicePlan({ plan: { action: 'start-relay', via: 'start', service: spec, row: ROW }, services, store });
    assert({ given: 'start plan', should: 'start only', actual: { calls, written: written.length }, expected: { calls: [`start:${spec.name}`], written: 1 } });
  });

  it('start-relay already-running: touches no service, only the row', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    await applyDevServerServicePlan({ plan: { action: 'start-relay', via: 'already-running', service: spec, row: ROW }, services, store });
    assert({ given: 'already-running', should: 'upsert only', actual: { calls, written: written.length }, expected: { calls: [], written: 1 } });
  });

  it('replace-relay: remove THEN create THEN upsert, in that order', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    const applied = await applyDevServerServicePlan({ plan: { action: 'replace-relay', previousTargetPort: 3000, service: spec, row: ROW }, services, store });
    assert({ given: 'replace plan', should: 'remove, create, upsert', actual: { calls, written: written.length }, expected: { calls: [`remove:${spec.name}`, `create:${spec.name}:node:${spec.args.length}`], written: 1 } });
    assert({ given: 'replace plan', should: 'report both ports', actual: applied, expected: { action: 'replace-relay', previousTargetPort: 3000, targetPort: 5173, recorded: true } });
  });

  it('record-direct: removes a leftover relay only when asked, and always upserts', async () => {
    const direct = { ...ROW, targetPort: 8080, relayServiceName: null };
    const a = fakeServices(); const sa = fakeStore();
    await applyDevServerServicePlan({ plan: { action: 'record-direct', removeRelay: true, row: direct }, services: a.services, store: sa.store });
    const b = fakeServices(); const sb = fakeStore();
    await applyDevServerServicePlan({ plan: { action: 'record-direct', removeRelay: false, row: direct }, services: b.services, store: sb.store });
    assert({ given: 'removeRelay true', should: 'remove the relay by its one name', actual: { calls: a.calls, written: sa.written }, expected: { calls: [`remove:${PREVIEW_RELAY_SERVICE_NAME}`], written: [direct] } });
    assert({ given: 'removeRelay false', should: 'touch no service', actual: { calls: b.calls, written: sb.written.length }, expected: { calls: [], written: 1 } });
  });

  const stopPlan: DevServerServicePlan = { action: 'stop-relay', relayServiceName: 'pagespace-preview-relay', holder: ROW.holder, stoppedByUserAt: STOPPED_AT };

  it('stop-relay: confirms the stop still stands, then stops the named relay and writes nothing (the intent is already on the row)', async () => {
    const { services, calls } = fakeServices();
    const { store, written, reads } = fakeStore({ stoppedByUserAt: STOPPED_AT });
    const applied = await applyDevServerServicePlan({ plan: stopPlan, services, store });
    assert({ given: 'stop plan, intent still set', should: 'read the intent then stop only', actual: { calls, written, reads }, expected: { calls: ['stop:pagespace-preview-relay'], written: [], reads: ['env:e1'] } });
    assert({ given: 'the stop', should: 'report it', actual: applied, expected: { action: 'stop-relay', relayServiceName: 'pagespace-preview-relay' } });
  });

  it('USER INTENT WINS: a stop-relay planned before the user RESUMED stops nothing (the intent is gone), and a row write the guard refuses reports skipped', async () => {
    // The mirror cases of one rule: the plan was made from a row the user has
    // since changed, so carrying it out would undo their click.
    const resumed = fakeServices();
    const resumedStore = fakeStore({ stoppedByUserAt: null });
    assert({
      given: 'a stop-relay for a stop the user has cleared',
      should: 'stop nothing and report skipped/resumed',
      actual: { applied: await applyDevServerServicePlan({ plan: stopPlan, services: resumed.services, store: resumedStore.store }), calls: resumed.calls },
      expected: { applied: { action: 'skipped', reason: 'resumed' }, calls: [] },
    });
    const gone = fakeServices();
    const goneStore = fakeStore({ missing: true });
    assert({
      given: 'a stop-relay for a holder whose row has gone',
      should: 'stop nothing',
      actual: { applied: await applyDevServerServicePlan({ plan: stopPlan, services: gone.services, store: goneStore.store }), calls: gone.calls },
      expected: { applied: { action: 'skipped', reason: 'resumed' }, calls: [] },
    });
    // The write side: the service call still happened (it was planned from a
    // truthful read), but the row write is refused, so the user's stop stands.
    const started = fakeServices();
    const refusing = fakeStore({ accepts: false });
    assert({
      given: 'a start-relay whose row write the intent guard refuses',
      should: 'report skipped/intent-changed, having started the relay',
      actual: { applied: await applyDevServerServicePlan({ plan: { action: 'start-relay', via: 'create', service: spec, row: ROW }, services: started.services, store: refusing.store }), calls: started.calls.length },
      expected: { applied: { action: 'skipped', reason: 'intent-changed' }, calls: 1 },
    });
    const replacing = fakeStore({ accepts: false });
    assert({
      given: 'a replace-relay the guard refuses',
      should: 'report skipped/intent-changed',
      actual: await applyDevServerServicePlan({ plan: { action: 'replace-relay', previousTargetPort: 3000, service: spec, row: ROW }, services: fakeServices().services, store: replacing.store }),
      expected: { action: 'skipped', reason: 'intent-changed' },
    });
    const direct = fakeStore({ accepts: false });
    assert({
      given: 'a record-direct the guard refuses',
      should: 'report skipped/intent-changed',
      actual: await applyDevServerServicePlan({ plan: { action: 'record-direct', removeRelay: false, row: { ...ROW, targetPort: 8080, relayServiceName: null } }, services: fakeServices().services, store: direct.store }),
      expected: { action: 'skipped', reason: 'intent-changed' },
    });
  });

  it('none / refuse: does nothing at all and reports the reason', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    const none = await applyDevServerServicePlan({ plan: { action: 'none', reason: 'already-relaying', staleRowIgnored: true }, services, store });
    const refuse = await applyDevServerServicePlan({ plan: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 }, services, store });
    assert({ given: 'none and refuse', should: 'touch nothing', actual: { calls, written }, expected: { calls: [], written: [] } });
    assert({ given: 'none', should: 'report', actual: none, expected: { action: 'none', reason: 'already-relaying', staleRowIgnored: true } });
    assert({ given: 'refuse', should: 'report with port', actual: refuse, expected: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 } });
  });

  it('a failed service call aborts BEFORE the row is written — never a row for a relay that did not start', async () => {
    const { services, calls } = fakeServices({ create: new Error('bind failed') });
    const { store, written } = fakeStore();
    await expect(applyDevServerServicePlan({ plan: { action: 'start-relay', via: 'create', service: spec, row: ROW }, services, store })).rejects.toThrow('bind failed');
    assert({ given: 'create threw', should: 'write no row', actual: { calls, written }, expected: { calls: [`create:${spec.name}:node:${spec.args.length}`], written: [] } });
  });
});

describe('probeRelayRuntime — socat is preferred only when the sprite proves it has it', () => {
  it('picks socat on a clean `command -v socat`', async () => {
    let seen: { cmd: string; args?: string[] } | undefined;
    const runtime = await probeRelayRuntime(async (args) => { seen = args; return { exitCode: 0, stdout: '/usr/bin/socat\n', stderr: '' }; });
    assert({ given: 'exit 0', should: 'socat', actual: runtime, expected: 'socat' });
    assert({ given: 'the probe', should: 'ask sh for socat', actual: seen, expected: { cmd: 'sh', args: ['-c', 'command -v socat'], timeoutMs: 10_000 } });
  });

  it('falls back to the verified node default on a non-zero exit or a thrown probe', async () => {
    assert({ given: 'exit 127', should: 'node', actual: await probeRelayRuntime(async () => ({ exitCode: 127, stdout: '', stderr: '' })), expected: 'node' });
    assert({ given: 'a throw', should: 'node', actual: await probeRelayRuntime(async () => { throw new Error('exec failed'); }), expected: 'node' });
  });
});
