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
};

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

function fakeStore() {
  const written: DevPreviewRowIntent[] = [];
  return { store: { upsert: async (intent: DevPreviewRowIntent) => { written.push(intent); } }, written };
}

const spec = buildPreviewRelaySpec({ targetPort: 5173 });

describe('applyDevServerServicePlan — obeys the plan, adds nothing', () => {
  it('start-relay via create: creates the exact spec, then upserts the exact row', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    const plan: DevServerServicePlan = { action: 'start-relay', via: 'create', service: spec, row: ROW };
    const applied = await applyDevServerServicePlan({ plan, services, store });
    assert({ given: 'create plan', should: 'create then upsert', actual: { calls, written }, expected: { calls: [`create:${spec.name}:node:${spec.args.length}`], written: [ROW] } });
    assert({ given: 'create plan', should: 'report', actual: applied, expected: { action: 'start-relay', via: 'create', targetPort: 5173 } });
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
    assert({ given: 'replace plan', should: 'report both ports', actual: applied, expected: { action: 'replace-relay', previousTargetPort: 3000, targetPort: 5173 } });
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

  it('stop-relay: stops the named relay and writes nothing (the stop intent is already on the row)', async () => {
    const { services, calls } = fakeServices();
    const { store, written } = fakeStore();
    await applyDevServerServicePlan({ plan: { action: 'stop-relay', relayServiceName: 'pagespace-preview-relay' }, services, store });
    assert({ given: 'stop plan', should: 'stop only', actual: { calls, written }, expected: { calls: ['stop:pagespace-preview-relay'], written: [] } });
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
