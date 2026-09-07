import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { SandboxServiceInfo } from '../../sandbox-host';
import {
  classifyDetectedDevServer,
  isHttpPortSlotFree,
  planDevServerService,
  describeServiceState,
  resolveDevPreviewHolder,
  HTTP_PORT_BUSY_MESSAGE,
  requiresPreviewApproval,
  isPreviewApproved,
  KNOWN_DEV_SERVER_PORTS,
  type DevPreviewHolderRef,
  type DevPreviewRow,
  type PlanDevServerServiceInput,
} from '../dev-preview-core';
import { PREVIEW_RELAY_SERVICE_NAME, SPRITE_HTTP_PORT, buildPreviewRelaySpec } from '../preview-relay';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const HOLDER: DevPreviewHolderRef = { kind: 'workspace', id: 'ws-1' };
const INSTANCE = 'sprite-live-0001';
const OLD_INSTANCE = 'sprite-dead-0000';

function relayService(targetPort: number, overrides: Partial<SandboxServiceInfo> = {}): SandboxServiceInfo {
  const spec = buildPreviewRelaySpec({ targetPort });
  return { name: spec.name, command: spec.command, args: spec.args, status: 'running', pid: 42, ...overrides };
}

function relayRow(targetPort: number, overrides: Partial<DevPreviewRow> = {}): DevPreviewRow {
  return {
    spriteInstanceId: INSTANCE,
    sandboxId: 'pgs-sbx-abc',
    targetPort,
    relayServiceName: targetPort === SPRITE_HTTP_PORT ? null : PREVIEW_RELAY_SERVICE_NAME,
    detectedAt: new Date('2026-09-05T11:00:00.000Z'),
    stoppedByUserAt: null,
    approvedPort: null,
    approvedAt: null,
    ...overrides,
  };
}

function planInput(overrides: Partial<PlanDevServerServiceInput> = {}): PlanDevServerServiceInput {
  return {
    liveInstanceId: INSTANCE,
    sandboxId: 'pgs-sbx-abc',
    holder: HOLDER,
    row: null,
    detected: null,
    relay: null,
    listeners: [],
    now: NOW,
    ...overrides,
  };
}

const detected = (port: number, pid?: number) =>
  ({ kind: 'dev-server', port, ...(pid !== undefined ? { pid } : {}), likelihood: 'unlisted' }) as const;

describe('classifyDetectedDevServer', () => {
  it('offers a plain port_opened as a dev server, with a likelihood hint', () => {
    assert({
      given: 'vite binding 5173',
      should: 'classify as a known-dev-port dev server carrying the pid',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 383 }, relay: null }),
      expected: { kind: 'dev-server', port: 5173, pid: 383, likelihood: 'known-dev-port' },
    });
    assert({
      given: 'an unlisted port',
      should: 'still be offered, marked unlisted',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 7777 }, relay: null }).kind,
      expected: 'dev-server',
    });
    assert({
      given: 'an unlisted port',
      should: 'carry the unlisted likelihood',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 7777 }, relay: null }),
      expected: { kind: 'dev-server', port: 7777, likelihood: 'unlisted' },
    });
  });

  it('never acts on port_closed (best-effort on the wire — spike §5/§9)', () => {
    assert({
      given: 'a port_closed frame for a dev-server port',
      should: 'ignore it with reason port-closed',
      actual: classifyDetectedDevServer({ event: { type: 'port_closed', port: 5173 }, relay: null }),
      expected: { kind: 'ignored', port: 5173, reason: 'port-closed' },
    });
  });

  it('recognises the relay binding 8080 as its own listener, not a new dev server', () => {
    const relay = relayService(5173, { pid: 42 });
    assert({
      given: 'a port_opened on 8080 with the relay pid while the relay is running',
      should: 'ignore it as the relay',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 8080, pid: 42 }, relay }),
      expected: { kind: 'ignored', port: 8080, reason: 'relay-own-listener' },
    });
    assert({
      given: 'a port_opened on 8080 with NO pid while the relay is starting',
      should: 'assume it is the relay',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 8080 }, relay: { ...relay, status: 'starting', pid: undefined } }).kind,
      expected: 'ignored',
    });
    assert({
      given: 'a port_opened on 8080 with a DIFFERENT pid while the relay is running',
      should: 'offer it — a user process took 8080',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 8080, pid: 99 }, relay }),
      expected: { kind: 'dev-server', port: 8080, pid: 99, likelihood: 'known-dev-port' },
    });
    assert({
      given: 'a port_opened on 8080 while the relay is failed',
      should: 'offer it directly (the user runs on 8080)',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 8080, pid: 42 }, relay: { ...relay, status: 'failed' } }).kind,
      expected: 'dev-server',
    });
    assert({
      given: 'a port_opened on 8080 with no relay defined',
      should: 'offer it directly',
      actual: classifyDetectedDevServer({ event: { type: 'port_opened', port: 8080, pid: 7 }, relay: null }).kind,
      expected: 'dev-server',
    });
  });

  it('ignores database/broker/inspector ports and non-ports', () => {
    for (const port of [5432, 6379, 27017, 9229]) {
      assert({
        given: `a port_opened on ${port}`,
        should: 'ignore it as a non-HTTP service port',
        actual: classifyDetectedDevServer({ event: { type: 'port_opened', port }, relay: null }),
        expected: { kind: 'ignored', port, reason: 'non-http-service-port' },
      });
    }
    for (const port of [0, 65536, 3.5, -1]) {
      assert({
        given: `port ${port}`,
        should: 'ignore it as out of range',
        actual: classifyDetectedDevServer({ event: { type: 'port_opened', port }, relay: null }),
        expected: { kind: 'ignored', port, reason: 'out-of-range' },
      });
    }
  });
});

describe('isHttpPortSlotFree — "is 8080 free: no relay, no user process"', () => {
  it('is free only when nothing holds 8080', () => {
    assert({ given: 'no listeners and no relay', should: 'be free', actual: isHttpPortSlotFree({ listeners: [], relay: null }), expected: true });
    assert({
      given: 'a listener on another port only',
      should: 'be free',
      actual: isHttpPortSlotFree({ listeners: [{ port: 5173, pid: 1 }], relay: null }),
      expected: true,
    });
    assert({
      given: 'a failed relay and no listener',
      should: 'be free (a dead relay holds nothing)',
      actual: isHttpPortSlotFree({ listeners: [], relay: relayService(5173, { status: 'failed' }) }),
      expected: true,
    });
  });

  it('is held by the relay when the relay is live', () => {
    assert({
      given: 'a running relay with no listener snapshot yet',
      should: 'not be free',
      actual: isHttpPortSlotFree({ listeners: [], relay: relayService(5173) }),
      expected: false,
    });
    assert({
      given: 'a running relay and a matching-pid listener on 8080',
      should: 'not be free',
      actual: isHttpPortSlotFree({ listeners: [{ port: 8080, pid: 42 }], relay: relayService(5173, { pid: 42 }) }),
      expected: false,
    });
  });

  it('is held by a user process when the listener is not the relay', () => {
    assert({
      given: 'a listener on 8080 and no relay',
      should: 'not be free',
      actual: isHttpPortSlotFree({ listeners: [{ port: 8080, pid: 9 }], relay: null }),
      expected: false,
    });
    assert({
      given: 'a listener on 8080 whose pid differs from the running relay',
      should: 'not be free',
      actual: isHttpPortSlotFree({ listeners: [{ port: 8080, pid: 9 }], relay: relayService(5173, { pid: 42 }) }),
      expected: false,
    });
  });
});

describe('planDevServerService', () => {
  it('refuses when the sprite instance is unknown (fail closed)', () => {
    assert({
      given: 'no live instance id, even with a detection and a row',
      should: 'refuse with instance-unknown',
      actual: planDevServerService(planInput({ liveInstanceId: null, detected: detected(5173), row: relayRow(5173) })),
      expected: { action: 'refuse', reason: 'instance-unknown' },
    });
  });

  it('starts a relay for a fresh detection on a free slot', () => {
    const plan = planDevServerService(planInput({ detected: detected(5173, 383) }));
    assert({
      given: 'vite on 5173, no row, no relay, nothing on 8080',
      should: 'plan start-relay via create with the row to record',
      actual: plan,
      expected: {
        action: 'start-relay',
        via: 'create',
        service: buildPreviewRelaySpec({ targetPort: 5173 }),
        row: { holder: HOLDER, spriteInstanceId: INSTANCE, sandboxId: 'pgs-sbx-abc', targetPort: 5173, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null },
      },
    });
  });

  it('honours the effects layer\'s runtime choice', () => {
    const plan = planDevServerService(planInput({ detected: detected(3000), relayRuntime: 'socat' }));
    assert({
      given: 'socat probed present',
      should: 'plan the socat relay',
      actual: plan.action === 'start-relay' ? plan.service.command : plan.action,
      expected: 'socat',
    });
  });

  it('refuses honestly when a user process holds 8080', () => {
    assert({
      given: 'a detection on 5173 while pid 9 listens on 8080 and no relay exists',
      should: 'refuse with http-port-busy naming the target',
      actual: planDevServerService(planInput({ detected: detected(5173), listeners: [{ port: 8080, pid: 9 }] })),
      expected: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 },
    });
  });

  it('refuses when a foreign pid holds 8080 even though the relay claims to be running', () => {
    assert({
      given: 'relay running as pid 42, but pid 9 listens on 8080',
      should: 'refuse with http-port-busy — the relay is not the one being served',
      actual: planDevServerService(planInput({ detected: detected(5173), row: relayRow(5173), relay: relayService(5173, { pid: 42 }), listeners: [{ port: 8080, pid: 9 }] })),
      expected: { action: 'refuse', reason: 'http-port-busy', targetPort: 5173 },
    });
  });

  it('does nothing when the identical relay is already live and recorded', () => {
    assert({
      given: 'row=5173, relay running for 5173, re-detection of 5173',
      should: 'plan none / already-relaying',
      actual: planDevServerService(planInput({ detected: detected(5173), row: relayRow(5173), relay: relayService(5173) })),
      expected: { action: 'none', reason: 'already-relaying', staleRowIgnored: false },
    });
  });

  it('records the row without touching a live relay the row does not describe', () => {
    const plan = planDevServerService(planInput({ detected: detected(5173), row: null, relay: relayService(5173) }));
    assert({
      given: 'relay running for 5173 but no row (lost write)',
      should: 'plan start-relay via already-running',
      actual: plan.action === 'start-relay' ? plan.via : plan.action,
      expected: 'already-running',
    });
  });

  it('restarts a defined-but-dead identical relay via start, not create', () => {
    const plan = planDevServerService(planInput({ detected: detected(5173), row: relayRow(5173), relay: relayService(5173, { status: 'failed', error: 'exited with code 1' }) }));
    assert({
      given: 'the 5173 relay crashed and 5173 is detected again',
      should: 'plan start-relay via start',
      actual: plan.action === 'start-relay' ? plan.via : plan.action,
      expected: 'start',
    });
  });

  it('re-points the relay when the dev server moves ports', () => {
    const plan = planDevServerService(planInput({ detected: detected(3000), row: relayRow(5173), relay: relayService(5173) }));
    assert({
      given: 'row=5173 relay live, next dev detected on 3000',
      should: 'plan replace-relay from 5173 with the 3000 service',
      actual: plan,
      expected: {
        action: 'replace-relay',
        previousTargetPort: 5173,
        service: buildPreviewRelaySpec({ targetPort: 3000 }),
        row: { holder: HOLDER, spriteInstanceId: INSTANCE, sandboxId: 'pgs-sbx-abc', targetPort: 3000, relayServiceName: PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null },
      },
    });
  });

  it('records a direct 8080 server with no relay, removing a leftover relay', () => {
    assert({
      given: 'a server detected on 8080, no row, no relay',
      should: 'plan record-direct with relayServiceName null and no removal',
      actual: planDevServerService(planInput({ detected: detected(8080, 5), listeners: [{ port: 8080, pid: 5 }] })),
      expected: {
        action: 'record-direct',
        removeRelay: false,
        row: { holder: HOLDER, spriteInstanceId: INSTANCE, sandboxId: 'pgs-sbx-abc', targetPort: 8080, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null },
      },
    });
    const plan = planDevServerService(planInput({ detected: detected(8080, 5), row: relayRow(5173), relay: relayService(5173, { status: 'failed' }) }));
    assert({
      given: 'the user moved to 8080 while a dead 5173 relay is still defined',
      should: 'plan record-direct and remove the relay',
      actual: plan.action === 'record-direct' ? plan.removeRelay : plan.action,
      expected: true,
    });
    assert({
      given: 'row already direct on 8080 and no relay',
      should: 'plan none / already-direct',
      actual: planDevServerService(planInput({ detected: detected(8080), row: relayRow(8080) })),
      expected: { action: 'none', reason: 'already-direct', staleRowIgnored: false },
    });
  });

  it('treats a row for another instance as absent — a re-provisioned sprite inherits nothing', () => {
    const stale = relayRow(5173, { spriteInstanceId: OLD_INSTANCE });
    assert({
      given: 'a stale row and no new detection',
      should: 'plan nothing and flag the stale row',
      actual: planDevServerService(planInput({ row: stale })),
      expected: { action: 'none', reason: 'nothing-detected', staleRowIgnored: true },
    });
    const revived = planDevServerService(planInput({ row: stale, detected: detected(3000) }));
    assert({
      given: 'a stale row (5173) and a fresh detection on the new instance (3000)',
      should: 'plan a fresh create for 3000 keyed to the live instance, not a replace from 5173',
      actual: revived.action === 'start-relay' ? { via: revived.via, instance: revived.row.spriteInstanceId, port: revived.row.targetPort } : revived.action,
      expected: { via: 'create', instance: INSTANCE, port: 3000 },
    });
    assert({
      given: 'a stale row that was stopped by the user',
      should: 'NOT carry the stop intent onto the new instance',
      actual: planDevServerService(planInput({ row: { ...stale, stoppedByUserAt: NOW }, detected: detected(3000) })).action,
      expected: 'start-relay',
    });
  });

  it('keeps a user-stopped preview stopped, and converges a still-running relay to stopped', () => {
    const stopped = relayRow(5173, { stoppedByUserAt: new Date('2026-09-05T11:30:00.000Z') });
    assert({
      given: 'a stopped row, relay already down, a new detection on 5173',
      should: 'plan none / user-stopped',
      actual: planDevServerService(planInput({ row: stopped, detected: detected(5173), relay: relayService(5173, { status: 'failed', error: 'exited with code 143' }) })),
      expected: { action: 'none', reason: 'user-stopped', staleRowIgnored: false },
    });
    assert({
      given: 'a stopped row, but the relay is still running',
      should: 'plan stop-relay',
      actual: planDevServerService(planInput({ row: stopped, relay: relayService(5173) })),
      expected: { action: 'stop-relay', relayServiceName: PREVIEW_RELAY_SERVICE_NAME, holder: HOLDER, stoppedByUserAt: stopped.stoppedByUserAt! },
    });
    assert({
      given: 'a stopped row and a detection on a DIFFERENT port',
      should: 'still stay stopped — only an explicit user action clears the intent',
      actual: planDevServerService(planInput({ row: stopped, detected: detected(3000) })).action,
      expected: 'none',
    });
  });

  it('reconciles on the row\'s own target when nothing new is detected', () => {
    const plan = planDevServerService(planInput({ row: relayRow(5173), relay: null }));
    assert({
      given: 'row=5173, relay vanished, no detection',
      should: 'plan start-relay via create for 5173 keeping the original detectedAt',
      actual: plan.action === 'start-relay' ? { via: plan.via, port: plan.row.targetPort, detectedAt: plan.row.detectedAt } : plan.action,
      expected: { via: 'create', port: 5173, detectedAt: relayRow(5173).detectedAt },
    });
    assert({
      given: 'no row and no detection',
      should: 'plan none / nothing-detected',
      actual: planDevServerService(planInput()),
      expected: { action: 'none', reason: 'nothing-detected', staleRowIgnored: false },
    });
  });

  it('never plans a relay whose target is the slot itself', () => {
    const plans = [
      planDevServerService(planInput({ detected: detected(8080) })),
      planDevServerService(planInput({ detected: detected(8080), row: relayRow(5173), relay: relayService(5173) })),
    ];
    for (const plan of plans) {
      expect(plan.action === 'start-relay' || plan.action === 'replace-relay').toBe(false);
    }
  });
});

describe('resolveDevPreviewHolder — the holder is whoever OWNS the sprite pointer', () => {
  it('keys an env-bound session\'s detection to the ENV, and an ephemeral session\'s to itself', () => {
    assert({ given: 'a session bound to env-1', should: 'resolve to the env holder', actual: resolveDevPreviewHolder({ id: 'ws-1', envId: 'env-1' }), expected: { kind: 'env', id: 'env-1' } });
    assert({ given: 'an ephemeral session', should: 'resolve to the workspace holder', actual: resolveDevPreviewHolder({ id: 'ws-1', envId: null }), expected: { kind: 'workspace', id: 'ws-1' } });
  });

  it('has two sessions in one env converge on ONE row intent', () => {
    const envHolder = resolveDevPreviewHolder({ id: 'ws-1', envId: 'env-1' });
    const first = planDevServerService(planInput({ holder: envHolder, detected: detected(5173) }));
    const second = planDevServerService(planInput({ holder: resolveDevPreviewHolder({ id: 'ws-2', envId: 'env-1' }), row: first.action === 'start-relay' ? { ...first.row, stoppedByUserAt: null, approvedPort: null, approvedAt: null } : null, relay: relayService(5173), detected: detected(5173) }));
    assert({ given: 'session ws-1 detecting 5173 in env-1', should: 'write an env-keyed row', actual: first.action === 'start-relay' ? first.row.holder : first.action, expected: { kind: 'env', id: 'env-1' } });
    assert({ given: 'session ws-2 then detecting the same server', should: 'find the env row already relaying and write nothing new', actual: second, expected: { action: 'none', reason: 'already-relaying', staleRowIgnored: false } });
  });
});

describe('planDevServerService — thrash guard', () => {
  it('keeps a known-dev-port target that is still listening over a new unlisted port', () => {
    assert({
      given: 'row=5173 (known) still bound, node --inspect opens 9230 (unlisted)',
      should: 'plan none / current-target-preferred',
      actual: planDevServerService(planInput({ row: relayRow(5173), relay: relayService(5173), listeners: [{ port: 5173, pid: 1 }, { port: 8080, pid: 42 }], detected: { kind: 'dev-server', port: 9230, likelihood: 'unlisted' } })),
      expected: { action: 'none', reason: 'current-target-preferred', staleRowIgnored: false },
    });
  });

  it('replaces freely once the current target stopped listening, or when the newcomer is a known dev port', () => {
    // The guard no longer applies (5173 is gone), so 9230 becomes the target —
    // but an unlisted target is not SHARED without a person's say-so, so the
    // plan is to record it and take the old relay down, not to re-point it.
    const gone = planDevServerService(planInput({ row: relayRow(5173), relay: relayService(5173), listeners: [{ port: 8080, pid: 42 }], detected: { kind: 'dev-server', port: 9230, likelihood: 'unlisted' } }));
    assert({ given: 'row=5173 no longer bound, unlisted 9230 opens', should: 'take the target but await approval, removing the old relay', actual: [gone.action, gone.action === 'await-approval' && gone.removeRelay], expected: ['await-approval', true] });
    const approvedGone = planDevServerService(planInput({ row: relayRow(5173, { approvedPort: 9230 }), relay: relayService(5173), listeners: [{ port: 8080, pid: 42 }], detected: { kind: 'dev-server', port: 9230, likelihood: 'unlisted' } }));
    assert({ given: 'the same move with 9230 already approved', should: 'replace the relay', actual: approvedGone.action, expected: 'replace-relay' });
    const known = planDevServerService(planInput({ row: relayRow(5173), relay: relayService(5173), listeners: [{ port: 5173, pid: 1 }], detected: { kind: 'dev-server', port: 3000, likelihood: 'known-dev-port' } }));
    assert({ given: 'row=5173 still bound, known 3000 opens', should: 'replace the relay', actual: known.action, expected: 'replace-relay' });
    const unlistedCurrent = planDevServerService(planInput({ row: relayRow(7777), relay: relayService(7777), listeners: [{ port: 7777, pid: 1 }], detected: { kind: 'dev-server', port: 9230, likelihood: 'unlisted' } }));
    assert({ given: 'row=7777 (unapproved, unlisted) still bound, unlisted 9230 opens', should: 'move to 9230 — an unapproved target is not worth defending', actual: unlistedCurrent.action, expected: 'await-approval' });
    // But an APPROVED unlisted target IS defended: otherwise a `node --inspect`
    // bind would knock a working, explicitly-shared preview back into
    // needs-approval and make the user agree to it a second time.
    const approvedCurrent = planDevServerService(planInput({ row: relayRow(7777, { approvedPort: 7777 }), relay: relayService(7777), listeners: [{ port: 7777, pid: 1 }], detected: { kind: 'dev-server', port: 9230, likelihood: 'unlisted' } }));
    assert({ given: 'row=7777 APPROVED and still bound, unlisted 9230 opens', should: 'keep the working preview', actual: [approvedCurrent.action, approvedCurrent.action === 'none' && approvedCurrent.reason], expected: ['none', 'current-target-preferred'] });
  });
});

describe('describeServiceState', () => {
  it('reports none / instance-unknown / stale before anything live is consulted', () => {
    assert({ given: 'no row', should: 'be none', actual: describeServiceState({ liveInstanceId: INSTANCE, row: null, relay: null, listeners: null }).status, expected: 'none' });
    assert({
      given: 'a row but no live instance id',
      should: 'be instance-unknown (fail closed)',
      actual: describeServiceState({ liveInstanceId: null, row: relayRow(5173), relay: relayService(5173), listeners: null }).status,
      expected: 'instance-unknown',
    });
    assert({
      given: 'a row for a previous instance while the relay looks live',
      should: 'be stale with the old target port',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(5173, { spriteInstanceId: OLD_INSTANCE }), relay: relayService(5173), listeners: null }),
      expected: {
        status: 'stale',
        targetPort: 5173,
        message: 'This sandbox was rebuilt since the preview on port 5173 was set up. Start the dev server again to re-create it.',
      },
    });
  });

  it('reports stopped from the row\'s intent, not the platform status (spike §4)', () => {
    const stoppedAt = new Date('2026-09-05T11:30:00.000Z');
    const state = describeServiceState({
      liveInstanceId: INSTANCE,
      row: relayRow(5173, { stoppedByUserAt: stoppedAt }),
      relay: relayService(5173, { status: 'failed', error: 'exited with code 143' }),
      listeners: [],
    });
    assert({ given: 'a user-stopped row whose relay reads failed', should: 'be stopped, not down', actual: state, expected: { status: 'stopped', targetPort: 5173, stoppedAt, message: 'Preview of port 5173 is switched off.' } });
  });

  it('folds relay status into starting / live / down', () => {
    const row = relayRow(5173);
    assert({ given: 'relay starting', should: 'be starting via relay', actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(5173, { status: 'starting' }), listeners: null }).status, expected: 'starting' });
    assert({
      given: 'relay running and no listener snapshot',
      should: 'be live via relay',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(5173), listeners: null }),
      expected: { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying port 8080 to your dev server on port 5173.' },
    });
    assert({
      given: 'relay running but the snapshot shows 5173 no longer bound',
      should: 'be down via relay (the dev server exited)',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(5173), listeners: [{ port: 8080, pid: 42 }] }).status,
      expected: 'down',
    });
    assert({
      given: 'relay failed with an error and no stop intent',
      should: 'be down carrying the error',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(5173, { status: 'failed', error: 'exited with code 1' }), listeners: [] }),
      expected: { status: 'down', targetPort: 5173, via: 'relay', error: 'exited with code 1', repairable: true, message: 'The preview relay for port 5173 is not running (exited with code 1).' },
    });
    assert({
      given: 'a relay row but no relay defined',
      should: 'be down with a null error',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: null, listeners: [] }),
      expected: { status: 'down', targetPort: 5173, via: 'relay', error: null, repairable: true, message: 'The preview relay for port 5173 is not defined on this sandbox.' },
    });
  });

  it('does not trust the relay NAME: a running relay that forwards elsewhere is down, not live', () => {
    const row = relayRow(5173);
    assert({
      given: 'row=5173 but the (single-named) relay service is running for 3000 — a replace whose row write was lost',
      should: 'be down naming the mismatch, not live',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(3000), listeners: null }),
      expected: { status: 'down', targetPort: 5173, via: 'relay', error: null, repairable: true, message: 'The preview relay on this sandbox forwards to a different port than 5173; it will be re-pointed on the next reconcile.' },
    });
    assert({
      given: 'the same mismatch while the relay is starting',
      should: 'still be down',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(3000, { status: 'starting' }), listeners: null }).status,
      expected: 'down',
    });
    const socat = buildPreviewRelaySpec({ targetPort: 5173, runtime: 'socat' });
    assert({
      given: 'a socat relay for the row\'s port (runtime is not on the row)',
      should: 'be accepted as live',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: { name: socat.name, command: socat.command, args: socat.args, status: 'running', pid: 7 }, listeners: null }).status,
      expected: 'live',
    });
  });

  it('reports blocked with the one honest fallback message when a user process holds 8080', () => {
    assert({
      given: 'a relay row, relay failed, pid 9 on 8080',
      should: 'be blocked with the run-on-8080 copy',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(5173), relay: relayService(5173, { status: 'failed' }), listeners: [{ port: 8080, pid: 9 }] }),
      expected: { status: 'blocked', targetPort: 5173, message: HTTP_PORT_BUSY_MESSAGE },
    });
    assert({
      given: 'a relay row, relay RUNNING as pid 42, pid 9 on 8080',
      should: 'still be blocked — a running relay that lost the bind is not serving',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(5173), relay: relayService(5173, { pid: 42 }), listeners: [{ port: 8080, pid: 9 }] }).status,
      expected: 'blocked',
    });
  });

  it('describes a direct 8080 preview from the listener snapshot alone', () => {
    const row = relayRow(8080);
    assert({ given: 'direct row, 8080 bound', should: 'be live via direct', actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: null, listeners: [{ port: 8080, pid: 5 }] }), expected: { status: 'live', targetPort: 8080, via: 'direct', message: 'Serving port 8080 directly.' } });
    assert({ given: 'direct row, snapshot shows 8080 unbound', should: 'be down via direct', actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: null, listeners: [] }).status, expected: 'down' });
    assert({ given: 'direct row, no snapshot', should: 'be live (nothing contradicts the row)', actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: null, listeners: null }).status, expected: 'live' });
    assert({
      given: 'direct row, but a leftover relay is still running on 8080',
      should: 'be down naming the leftover relay (same slot-holder read as the relay branch)',
      actual: describeServiceState({ liveInstanceId: INSTANCE, row, relay: relayService(5173), listeners: [{ port: 8080, pid: 42 }] }),
      expected: { status: 'down', targetPort: 8080, via: 'direct', error: null, repairable: true, message: 'A leftover preview relay still holds port 8080; it will be removed on the next reconcile.' },
    });
  });

  /**
   * `down.repairable` is a PROMISE ABOUT THE PLANNER, so it is asserted
   * against the planner rather than restated: for every `down` a reconcile
   * can reach, run the exact plan a resume would run (`detected: null`, same
   * row, same relay, same snapshot) and require `repairable` to equal
   * "this plan does something". A `none` plan (`already-direct` /
   * `already-relaying`) is a Restart button that provably no-ops.
   */
  it('repairable says exactly whether a reconcile\'s plan would change anything', () => {
    const cases: { name: string; row: DevPreviewRow; relay: SandboxServiceInfo | null; listeners: readonly { port: number; pid?: number }[] }[] = [
      { name: 'relay crashed', row: relayRow(5173), relay: relayService(5173, { status: 'failed', error: 'boom' }), listeners: [{ port: 5173, pid: 7 }] },
      { name: 'relay undefined', row: relayRow(5173), relay: null, listeners: [{ port: 5173, pid: 7 }] },
      { name: 'relay pointed elsewhere', row: relayRow(5173), relay: relayService(3000), listeners: [{ port: 5173, pid: 7 }] },
      { name: 'relay running, target gone', row: relayRow(5173), relay: relayService(5173), listeners: [{ port: SPRITE_HTTP_PORT, pid: 42 }] },
      { name: 'direct row, leftover relay on 8080', row: relayRow(SPRITE_HTTP_PORT), relay: relayService(5173), listeners: [{ port: SPRITE_HTTP_PORT, pid: 42 }] },
      { name: 'direct row, server gone', row: relayRow(SPRITE_HTTP_PORT), relay: null, listeners: [] },
    ];
    for (const { name, row, relay, listeners } of cases) {
      const state = describeServiceState({ liveInstanceId: INSTANCE, row, relay, listeners });
      expect(state.status, `${name} should be down`).toBe('down');
      if (state.status !== 'down') continue;
      const plan = planDevServerService(planInput({ row, relay, listeners, detected: null }));
      assert({
        given: name,
        should: 'mark repairable iff the resume\'s own plan is not a no-op',
        actual: [state.repairable, plan.action === 'none' ? `none:${plan.reason}` : plan.action],
        expected: [plan.action !== 'none', plan.action === 'none' ? `none:${plan.reason}` : plan.action],
      });
    }
  });

  it('has no public-exposure state anywhere in its vocabulary', () => {
    const state = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(5173), relay: relayService(5173), listeners: null });
    expect(JSON.stringify(state).toLowerCase()).not.toContain('public');
    expect(Object.keys(state)).not.toContain('url');
  });
});

describe('sharing an UNLISTED port is a decision, not a default', () => {
  it('draws the line at the known dev-server ports, and nowhere else', () => {
    for (const port of KNOWN_DEV_SERVER_PORTS) {
      assert({ given: `port ${port}`, should: 'need no approval — running the tool IS the ask', actual: requiresPreviewApproval(port), expected: false });
    }
    for (const port of [9000, 7777, 9230, 4444, 1]) {
      assert({ given: `port ${port}`, should: 'need approval', actual: requiresPreviewApproval(port), expected: true });
    }
    assert({ given: 'no row at all', should: 'never count as approved', actual: isPreviewApproved(null, 9000), expected: false });
    assert({ given: 'approval for another port', should: 'not carry over — approval is per PORT', actual: isPreviewApproved({ approvedPort: 9000 }, 9001), expected: false });
    assert({ given: 'approval for this port', should: 'count', actual: isPreviewApproved({ approvedPort: 9000 }, 9000), expected: true });
  });

  it('a fresh unlisted detection is RECORDED but never relayed — the row it writes serves nothing', () => {
    const plan = planDevServerService(planInput({ detected: { kind: 'dev-server', port: 9000, likelihood: 'unlisted' } }));
    assert({
      given: 'a dev server on 9000 with no approval',
      should: 'await approval, writing a row with NO relay',
      actual: plan,
      expected: {
        action: 'await-approval',
        targetPort: 9000,
        removeRelay: false,
        row: { holder: HOLDER, spriteInstanceId: INSTANCE, sandboxId: 'pgs-sbx-abc', targetPort: 9000, relayServiceName: null, detectedAt: NOW, stoppedByUserAt: null, basedOnStoppedByUserAt: null },
      },
    });
  });

  it('the approval unlocks exactly the port it names, and the relay starts on the next plan', () => {
    const approved = planDevServerService(planInput({ row: relayRow(9000, { relayServiceName: null, approvedPort: 9000 }), detected: { kind: 'dev-server', port: 9000, likelihood: 'unlisted' } }));
    assert({ given: '9000 approved', should: 'create the relay', actual: [approved.action, approved.action === 'start-relay' && approved.via], expected: ['start-relay', 'create'] });

    // The server moved to another unlisted port: the old approval does not
    // travel with it, so exposure stops until the user agrees again.
    const moved = planDevServerService(planInput({ row: relayRow(9000, { approvedPort: 9000 }), relay: relayService(9000), listeners: [{ port: 8080, pid: 42 }], detected: { kind: 'dev-server', port: 9001, likelihood: 'unlisted' } }));
    assert({ given: 'an approved 9000 moving to 9001', should: 'await approval again AND remove the 9000 relay', actual: [moved.action, moved.action === 'await-approval' && moved.removeRelay], expected: ['await-approval', true] });
  });

  it('never asks about 8080 or a known port, and asks BEFORE the slot questions', () => {
    const direct = planDevServerService(planInput({ detected: detected(8080, 5), listeners: [{ port: 8080, pid: 5 }] }));
    assert({ given: 'the server on 8080 itself', should: 'record directly — 8080 is a known dev port', actual: direct.action, expected: 'record-direct' });
    const known = planDevServerService(planInput({ detected: detected(5173) }));
    assert({ given: 'vite on 5173', should: 'start the relay with no approval', actual: known.action, expected: 'start-relay' });

    // A held slot and an unknown snapshot are both answers about STARTING
    // something. Nothing is being started here, so neither is the honest reason.
    const busy = planDevServerService(planInput({ detected: { kind: 'dev-server', port: 9000, likelihood: 'unlisted' }, listeners: [{ port: 8080, pid: 99 }] }));
    assert({ given: 'an unlisted port while a stranger holds 8080', should: 'still be await-approval, not http-port-busy', actual: busy.action, expected: 'await-approval' });
    const blind = planDevServerService(planInput({ detected: { kind: 'dev-server', port: 9000, likelihood: 'unlisted' }, listenersKnown: false }));
    assert({ given: 'an unlisted port with no listener snapshot', should: 'still be await-approval, not slot-unknown', actual: blind.action, expected: 'await-approval' });
  });

  it('a STOP still outranks approval — the user switching it off is never overridden by a pending decision', () => {
    const stopped = planDevServerService(planInput({ row: relayRow(9000, { relayServiceName: null, stoppedByUserAt: NOW }), detected: { kind: 'dev-server', port: 9000, likelihood: 'unlisted' } }));
    assert({ given: 'an unlisted port on a switched-off preview', should: 'stay off', actual: [stopped.action, stopped.action === 'none' && stopped.reason], expected: ['none', 'user-stopped'] });
  });

  it('describeServiceState says needs-approval, and says STARTING once approved but not yet relayed', () => {
    const waiting = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(9000, { relayServiceName: null }), relay: null, listeners: null });
    assert({ given: 'a recorded but unapproved 9000', should: 'be needs-approval naming the port', actual: [waiting.status, waiting.status === 'needs-approval' && waiting.targetPort], expected: ['needs-approval', 9000] });
    expect(waiting.message).toContain('9000');

    // DOWN, not "starting…": the relay is created in the same call that
    // records the consent, so a row in this shape means that create did not
    // happen and nothing necessarily retries it. `down` is what keeps the
    // Restart control on screen; "starting" would promise an arrival that
    // never comes.
    const approved = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(9000, { relayServiceName: null, approvedPort: 9000 }), relay: null, listeners: null });
    assert({ given: 'approved but no relay was created', should: 'read as down and stay recoverable', actual: [approved.status, approved.status === 'down' && approved.via], expected: ['down', 'relay'] });

    // The relay was planned and REFUSED because a stranger holds 8080. Saying
    // "starting…" would be a lie that never resolves and would hide the one
    // thing the user can act on.
    const held = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(9000, { relayServiceName: null, approvedPort: 9000 }), relay: null, listeners: [{ port: 8080, pid: 99 }] });
    assert({ given: 'approved while a user process holds 8080', should: 'say the port is busy, not "starting"', actual: [held.status, held.message], expected: ['blocked', HTTP_PORT_BUSY_MESSAGE] });
    // With no snapshot the slot is UNKNOWN, which is not evidence of a problem.
    assert({ given: 'approved with no listener snapshot', should: 'stay down rather than invent a blockage', actual: describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(9000, { relayServiceName: null, approvedPort: 9000 }), relay: null, listeners: null }).status, expected: 'down' });

    // A row can reach the relay-less branch with an ORDINARY dev-server port:
    // a stop records that the relay is gone, and the resume clears the stop
    // before the relay is re-created. That must not demand consent for a port
    // that never needed any — the whole Share affordance would appear on a
    // vite server the user has been previewing all along.
    const resumedKnownPort = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(5173, { relayServiceName: null }), relay: null, listeners: null });
    assert({ given: 'a known dev port whose relay was stopped and then resumed', should: 'read as down — recoverable in one click — never as needs-approval', actual: resumedKnownPort.status, expected: 'down' });

    const off = describeServiceState({ liveInstanceId: INSTANCE, row: relayRow(9000, { relayServiceName: null, stoppedByUserAt: NOW }), relay: null, listeners: null });
    assert({ given: 'a switched-off unapproved preview', should: 'read as stopped, not as a pending decision', actual: off.status, expected: 'stopped' });
  });
});
