import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { decidePreviewForward, type PreviewForwardInput } from '../preview-forward-gate';
import type { DevPreviewServiceState } from '../dev-preview-core';

const LIVE: DevPreviewServiceState = { status: 'live', targetPort: 5173, via: 'relay', message: 'Relaying.' };

function input(overrides: Partial<PreviewForwardInput> = {}): PreviewForwardInput {
  return {
    featureEnabled: true,
    authz: { allowed: true },
    state: LIVE,
    power: 'running',
    wakeAuthorization: 'not-consulted',
    ...overrides,
  };
}

describe('decidePreviewForward — order of refusal', () => {
  it('forwards a live preview on a running sprite without consulting the wake gate', () => {
    assert({
      given: 'feature on, authorized, live, running',
      should: 'forward, not a wake',
      actual: decidePreviewForward(input()),
      expected: { kind: 'forward', wake: false },
    });
  });

  it('refuses everything when the feature is dark — before authz, before state', () => {
    assert({
      given: 'feature off with an otherwise forwardable request',
      should: 'refuse as not found, revealing nothing',
      actual: decidePreviewForward(input({ featureEnabled: false })),
      expected: { kind: 'refuse', reason: 'feature-disabled', status: 404, message: 'Not found' },
    });
  });

  it('refuses a denied requester as not found, carrying the gate reason only as audit detail', () => {
    assert({
      given: 'the holder gate denied',
      should: 'refuse 404 with the reason in detail, not in the message',
      actual: decidePreviewForward(input({ authz: { allowed: false, reason: 'drive_access_denied' } })),
      expected: { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: 'drive_access_denied' },
    });
  });

  it('never reaches the wake gate for a denied requester on a paused sprite — a denied request must not wake anything', () => {
    const decision = decidePreviewForward(input({ authz: { allowed: false, reason: 'x' }, power: 'paused' }));
    assert({
      given: 'denied authz and a paused sprite',
      should: 'refuse outright rather than ask for the wake gate',
      actual: decision.kind,
      expected: 'refuse',
    });
  });

  it('refuses when there is no preview (null state or status none)', () => {
    assert({
      given: 'no sprite could be attached',
      should: 'refuse 404 no-preview',
      actual: decidePreviewForward(input({ state: null })).kind === 'refuse' && (decidePreviewForward(input({ state: null })) as { reason: string }).reason,
      expected: 'no-preview',
    });
    assert({
      given: 'a state of none',
      should: 'refuse 404 no-preview',
      actual: (decidePreviewForward(input({ state: { status: 'none', message: 'nothing' } })) as { status: number }).status,
      expected: 404,
    });
  });

  it.each([
    [{ status: 'stale', targetPort: 3000, message: 'rebuilt' }, 'stale-instance', 409],
    [{ status: 'instance-unknown', message: 'unknown' }, 'instance-unknown', 409],
    [{ status: 'stopped', targetPort: 3000, stoppedAt: new Date(0), message: 'off' }, 'stopped-by-user', 409],
    [{ status: 'blocked', targetPort: 3000, message: 'busy' }, 'http-port-busy', 409],
    [{ status: 'down', targetPort: 3000, via: 'relay', error: null, repairable: true, message: 'down' }, 'preview-down', 502],
    [{ status: 'starting', targetPort: 3000, via: 'relay', message: 'starting' }, 'preview-starting', 503],
  ] as const)('refuses a %o preview and never routes it (the stale-instance rule)', (state, reason, status) => {
    const decision = decidePreviewForward(input({ state: state as DevPreviewServiceState, power: 'paused' }));
    assert({
      given: `state ${state.status} on a paused sprite`,
      should: `refuse ${reason} ${status} without asking for the wake gate`,
      actual: decision,
      expected: { kind: 'refuse', reason, status, message: state.message },
    });
  });
});

describe('decidePreviewForward — the wake gate', () => {
  it.each(['paused', 'unknown', null] as const)('asks for the wake gate when the sprite is %s and the gate has not been consulted', (power) => {
    assert({
      given: `a live preview on a ${power} sprite, gate not consulted`,
      should: 'ask the caller to consult canRunCode',
      actual: decidePreviewForward(input({ power })),
      expected: { kind: 'needs-wake-gate' },
    });
  });

  it('forwards as a WAKE once the gate allows', () => {
    assert({
      given: 'a paused sprite and canRunCode ok',
      should: 'forward, flagged as a wake for the access log',
      actual: decidePreviewForward(input({ power: 'paused', wakeAuthorization: { ok: true } })),
      expected: { kind: 'forward', wake: true },
    });
  });

  it('refuses the wake when the gate denies, naming the gate reason only in detail', () => {
    assert({
      given: 'a paused sprite and canRunCode denied for tier',
      should: 'refuse 403 wake-denied',
      actual: decidePreviewForward(input({ power: 'paused', wakeAuthorization: { ok: false, reason: 'tier_ineligible' } })),
      expected: {
        kind: 'refuse',
        reason: 'wake-denied',
        status: 403,
        message: 'This sandbox is asleep, and you are not permitted to wake it.',
        detail: 'tier_ineligible',
      },
    });
  });

  it('does not let a consulted-and-allowed gate matter when the sprite is running (no wake to authorize)', () => {
    assert({
      given: 'running sprite and a denied gate answer',
      should: 'still forward without a wake — the gate governs wakes, not views',
      actual: decidePreviewForward(input({ power: 'running', wakeAuthorization: { ok: false, reason: 'kill_switch_off' } })),
      expected: { kind: 'forward', wake: false },
    });
  });
});
