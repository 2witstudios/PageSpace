/**
 * The backstop sweep: the ONE thing it may do is stop a relay whose row says
 * the user switched it off. Everything else about it is a refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { SPRITE_SANDBOX_CAPABILITIES, type SandboxHandle, type SandboxServiceInfo } from '../../sandbox-host';
import {
  reconcileStoppedDevPreviews,
  DEV_PREVIEW_SWEEP_STALE_AFTER_MS,
  DEV_PREVIEW_SWEEP_LIMIT,
  type DevPreviewReconcileDeps,
} from '../dev-preview-reconcile';
import type { DevPreviewRecord, DevPreviewStore } from '../dev-preview-store';
import type { DevPreviewLock } from '../dev-preview-lock';
import { buildPreviewRelaySpec, PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';

const NOW = new Date('2026-09-07T12:00:00Z');
const INSTANCE = 'sprite-live-0001';
const HOLDER = { kind: 'env', id: 'env1' } as const;

const relayService = (targetPort: number, status: SandboxServiceInfo['status'] = 'running'): SandboxServiceInfo => {
  const spec = buildPreviewRelaySpec({ targetPort });
  return { name: spec.name, command: spec.command, args: spec.args, status, pid: 42 };
};

const row = (over: Partial<DevPreviewRecord> = {}): DevPreviewRecord => ({
  id: 'r1',
  spriteInstanceId: INSTANCE,
  sandboxId: 'sbx',
  targetPort: 5173,
  relayServiceName: PREVIEW_RELAY_SERVICE_NAME,
  detectedAt: NOW,
  stoppedByUserAt: NOW,
  approvedPort: null,
  approvedAt: null,
  ...over,
});

function fakeHandle(calls: string[], relay: SandboxServiceInfo | null): SandboxHandle {
  return {
    sandboxId: 'sbx',
    capabilities: SPRITE_SANDBOX_CAPABILITIES,
    spriteInstanceId: INSTANCE,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => { throw new Error('unused'); },
    listStreams: async () => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
    services: {
      create: async (spec) => { calls.push(`create:${spec.name}`); },
      list: async () => [],
      get: async () => { calls.push('services.get'); return relay; },
      start: async (name) => { calls.push(`start:${name}`); },
      stop: async (name) => { calls.push(`stop:${name}`); },
      remove: async (name) => { calls.push(`remove:${name}`); },
    },
    urlInfo: async () => ({ url: null, auth: 'unknown' }),
    setUrlAuth: async () => {},
    powerState: async () => 'running',
  };
}

function fakeStore(current: DevPreviewRecord | null, calls: string[]): DevPreviewStore {
  let held = current;
  return {
    findByHolder: async () => { calls.push('findByHolder'); return held; },
    upsert: async () => { calls.push('upsert'); return true; },
    setStoppedByUser: async (_h, at) => { held = held === null ? null : { ...held, stoppedByUserAt: at }; return held; },
    approvePort: async () => null,
    findStoppedWithRelay: async () => [],
    markSwept: async () => {},
    markRelayStopped: async () => {},
  };
}

function harness(over: Partial<DevPreviewReconcileDeps> & { current?: DevPreviewRecord | null; relay?: SandboxServiceInfo | null } = {}) {
  const calls: string[] = [];
  const store = fakeStore(over.current === undefined ? row() : over.current, calls);
  const swept: string[] = [];
  const deps: DevPreviewReconcileDeps = {
    findStoppedWithRelay: async () => [{ holder: HOLDER, sandboxId: 'sbx' }],
    markSwept: async (holder) => { swept.push(`${holder.kind}:${holder.id}`); },
    attach: async () => fakeHandle(calls, over.relay === undefined ? relayService(5173) : over.relay),
    previewStore: store,
    featureEnabled: () => true,
    now: () => NOW,
    ...over,
  };
  return { deps, calls, swept };
}

describe('reconcileStoppedDevPreviews', () => {
  it('stops a relay whose row says the user switched it off', async () => {
    const { deps, calls } = harness();
    assert({ given: 'a stopped row with a live relay', should: 'stop exactly one', actual: await reconcileStoppedDevPreviews(deps), expected: { processed: 1, stopped: 1, skipped: 0, failed: 0 } });
    assert({ given: 'the sweep', should: 'stop the relay and nothing else', actual: calls.filter((c) => c.startsWith('stop:') || c.startsWith('create:') || c.startsWith('start:')), expected: [`stop:${PREVIEW_RELAY_SERVICE_NAME}`] });
  });

  it('CAN NEVER START ANYTHING — the property the whole module exists for', async () => {
    // A row with the stop CLEARED and no relay defined is exactly the shape a
    // detector would answer with `start-relay via create`. The sweep must not:
    // the re-read refuses to act on a row that is not switched off, and even
    // past that, it holds no snapshot proving 8080 is free.
    const { deps, calls } = harness({ current: row({ stoppedByUserAt: null, relayServiceName: null, targetPort: 5173 }), relay: null });
    const run = await reconcileStoppedDevPreviews(deps);
    assert({ given: 'a row that would tempt a start', should: 'skip', actual: run, expected: { processed: 1, stopped: 0, skipped: 1, failed: 0 } });
    assert({ given: 'the sweep', should: 'never call create or start', actual: calls.some((c) => c.startsWith('create:') || c.startsWith('start:')), expected: false });

    // And even with the stop still set, a row whose relay is already gone is
    // simply nothing to do — never a re-creation.
    const gone = harness({ current: row({ relayServiceName: null }), relay: null });
    await reconcileStoppedDevPreviews(gone.deps);
    assert({ given: 'a stopped row with no relay recorded', should: 'touch the sprite not at all', actual: gone.calls.includes('services.get'), expected: false });
  });

  it('RE-READS under the lock: a resume that landed since the listing is honoured, not overridden', async () => {
    const { deps, calls } = harness({ current: row({ stoppedByUserAt: null }) });
    assert({ given: 'the intent cleared between listing and sweep', should: 'skip', actual: await reconcileStoppedDevPreviews(deps), expected: { processed: 1, stopped: 0, skipped: 1, failed: 0 } });
    assert({ given: 'a resumed holder', should: 'never reach the sprite', actual: calls.includes('services.get'), expected: false });
  });

  it('skips a holder a live path already owns, without running anything', async () => {
    const busy: DevPreviewLock = async () => ({ outcome: 'busy' });
    const { deps, calls } = harness({ lock: busy });
    assert({ given: 'a contended holder', should: 'skip', actual: await reconcileStoppedDevPreviews(deps), expected: { processed: 1, stopped: 0, skipped: 1, failed: 0 } });
    assert({ given: 'a contended holder', should: 'not even read the row', actual: calls, expected: [] });
  });

  it('a vanished sprite is a skip, and a throwing one is a counted failure that does not stop the run', async () => {
    const vanished = harness({ attach: async () => null });
    assert({ given: 'attach → null', should: 'skip', actual: await reconcileStoppedDevPreviews(vanished.deps), expected: { processed: 1, stopped: 0, skipped: 1, failed: 0 } });

    const warn = vi.fn();
    const thrower = harness({
      findStoppedWithRelay: async () => [{ holder: HOLDER, sandboxId: 'sbx' }, { holder: { kind: 'workspace', id: 'ws1' }, sandboxId: 'sbx' }],
      attach: async () => { throw new Error('control plane down'); },
      log: { warn },
    });
    assert({ given: 'an attach that throws for every candidate', should: 'count both failures and keep going', actual: await reconcileStoppedDevPreviews(thrower.deps), expected: { processed: 2, stopped: 0, skipped: 0, failed: 2 } });
    expect(warn).toHaveBeenCalledTimes(2);
    // A holder that RELIABLY errors must still leave the window, or fifty of
    // them sit at the head of every oldest-first batch forever — the same
    // starvation this sweep exists to remove, narrowed to the failing rows.
    assert({ given: 'holders whose work threw', should: 'stamp them anyway, as the retry backoff', actual: thrower.swept, expected: ['env:env1', 'workspace:ws1'] });
  });

  it('does nothing at all when the feature is dark — not even the listing query', async () => {
    const findStoppedWithRelay = vi.fn(async () => []);
    const { deps } = harness({ featureEnabled: () => false, findStoppedWithRelay });
    assert({ given: 'a dark deployment', should: 'be a no-op', actual: await reconcileStoppedDevPreviews(deps), expected: { processed: 0, stopped: 0, skipped: 0, failed: 0 } });
    expect(findStoppedWithRelay).not.toHaveBeenCalled();
  });

  it('asks for a bounded, aged batch — the two things that keep it off live work', async () => {
    let asked: unknown;
    const { deps } = harness({ findStoppedWithRelay: async (input) => { asked = input; return []; } });
    await reconcileStoppedDevPreviews(deps);
    assert({ given: 'the listing', should: 'be capped and age-bounded', actual: asked, expected: { staleAfterMs: DEV_PREVIEW_SWEEP_STALE_AFTER_MS, limit: DEV_PREVIEW_SWEEP_LIMIT } });
  });

  it('STAMPS every holder it looked at, so a converged row cannot occupy the batch forever', async () => {
    // The stop itself writes nothing, so without the stamp a converged row
    // keeps matching the oldest-first, capped candidate query — fifty dead
    // rows would fill every tick and starve the holder who stopped a preview
    // a minute ago.
    const stopped = harness();
    await reconcileStoppedDevPreviews(stopped.deps);
    assert({ given: 'a relay it stopped', should: 'stamp the row out of the window', actual: stopped.swept, expected: ['env:env1'] });

    const nothingToDo = harness({ current: row({ stoppedByUserAt: null }) });
    await reconcileStoppedDevPreviews(nothingToDo.deps);
    assert({ given: 'a row that needed nothing', should: 'still stamp it', actual: nothingToDo.swept, expected: ['env:env1'] });

    const vanished = harness({ attach: async () => null });
    await reconcileStoppedDevPreviews(vanished.deps);
    assert({ given: 'a sprite the platform no longer has', should: 'stamp it rather than re-attach it every tick forever', actual: vanished.swept, expected: ['env:env1'] });

    // A stamp that itself fails is bookkeeping, and must not turn a stop that
    // DID happen into a reported failure.
    const stampBroken = harness({ markSwept: async () => { throw new Error('db down'); }, log: { warn: () => {} } });
    assert({ given: 'a stamp that throws after a successful stop', should: 'still report the stop', actual: await reconcileStoppedDevPreviews(stampBroken.deps), expected: { processed: 1, stopped: 1, skipped: 0, failed: 0 } });

    // Contended is the one case that must NOT be stamped: a live path owns the
    // holder, and if it does not finish the next tick has to be able to.
    const busy = harness({ lock: async () => ({ outcome: 'busy' }) });
    await reconcileStoppedDevPreviews(busy.deps);
    assert({ given: 'a holder a live path owns', should: 'leave it in the window', actual: busy.swept, expected: [] });
  });
});
