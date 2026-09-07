import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { LocalEnvUnsupportedError, SPRITE_SANDBOX_CAPABILITIES, type SandboxCapabilities, type SandboxHandle, type SandboxServiceInfo } from '../../sandbox-host';
import { authorizePreviewHolder, resolvePreviewTarget, type PreviewAccessDeps, type PreviewEnvRow, type PreviewSessionRow } from '../preview-access';
import type { DevPreviewRecord } from '../dev-preview-store';
import { buildPreviewRelaySpec, PREVIEW_RELAY_SERVICE_NAME } from '../preview-relay';

const NOW = new Date('2026-09-06T12:00:00Z');
const USER = 'user-1';
const OWNER = 'owner-1';
const SESSION = 'sess-1';

const session = (over: Partial<PreviewSessionRow> = {}): PreviewSessionRow => ({
  id: 'ws1', ownerId: OWNER, driveId: 'd1', envId: null, sandboxId: 'sbx-ws', spriteTornDownAt: null, endedAt: null, ...over,
});
const env = (over: Partial<PreviewEnvRow> = {}): PreviewEnvRow => ({
  id: 'env1', driveId: 'd1', substrate: 'sprite', sandboxId: 'sbx-env', spriteTornDownAt: null, ...over,
});
const liveRow = (targetPort = 5173): DevPreviewRecord => ({
  id: 'r', spriteInstanceId: 'inst-1', sandboxId: 'sbx-env', targetPort, relayServiceName: targetPort === 8080 ? null : PREVIEW_RELAY_SERVICE_NAME, detectedAt: NOW, stoppedByUserAt: null,
});
const runningRelay = (targetPort = 5173): SandboxServiceInfo => {
  const spec = buildPreviewRelaySpec({ targetPort });
  return { name: spec.name, command: spec.command, args: spec.args, status: 'running', pid: 1 };
};

function fakeHandle(over: Partial<{ power: 'running' | 'paused' | 'unknown'; url: string | null; auth: 'sprite' | 'public' | 'unknown'; relay: SandboxServiceInfo | null; instance: string | null; capabilities: SandboxCapabilities }> = {}): SandboxHandle {
  return {
    capabilities: over.capabilities ?? SPRITE_SANDBOX_CAPABILITIES,
    sandboxId: 'sbx-env',
    spriteInstanceId: over.instance === undefined ? 'inst-1' : over.instance,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => { throw new Error('unused'); },
    listStreams: async () => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
    services: { create: async () => {}, list: async () => [], get: async () => over.relay ?? null, start: async () => {}, stop: async () => {}, remove: async () => {} },
    urlInfo: async () => ({ url: over.url === undefined ? 'https://ps-x-org.sprites.app' : over.url, auth: over.auth ?? 'sprite' }),
    setUrlAuth: async () => {},
    powerState: async () => over.power ?? 'running',
  };
}

function deps(over: Partial<PreviewAccessDeps> & { calls?: string[] } = {}): PreviewAccessDeps & { calls: string[] } {
  const calls = over.calls ?? [];
  const track = <T,>(name: string, value: T) => { calls.push(name); return value; };
  return {
    calls,
    findSession: async () => track('findSession', session()),
    findEnv: async () => track('findEnv', env()),
    resolveDriveMembership: async () => track('membership', 'member' as const),
    resolveDrivePayer: async () => track('payer', { payerId: OWNER }),
    canRunCode: async () => track('canRunCode', { ok: true as const }),
    isSessionUsable: async () => track('isSessionUsable', true),
    attach: async () => track('attach', fakeHandle({ relay: runningRelay() })),
    previewStore: { findByHolder: async () => track('findRow', liveRow()), upsert: async () => true, setStoppedByUser: async () => null },
    featureEnabled: () => true,
    now: () => NOW,
    ...over,
  };
}

describe('authorizePreviewHolder — database facts only', () => {
  it('a drive member may reach a drive session (the same decider the session routes use)', async () => {
    const d = deps();
    const result = await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: USER, deps: d });
    assert({ given: 'member of the session drive', should: 'allow with the payer subject and the live sprite', actual: result, expected: { allowed: true, driveId: 'd1', wakeSubject: { driveId: 'd1', ownerId: OWNER }, sandboxId: 'sbx-ws' } });
  });

  it('a non-member is refused with the decider reason, and the membership is the last read', async () => {
    const d = deps({ resolveDriveMembership: async () => 'none' });
    assert({ given: 'no membership', should: 'refuse', actual: await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: USER, deps: d }), expected: { allowed: false, reason: 'drive_access_denied' } });
  });

  it('a global-assistant session is owner-only', async () => {
    const d = deps({ findSession: async () => session({ driveId: null }) });
    assert({ given: 'a stranger', should: 'refuse', actual: (await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: USER, deps: d })).allowed, expected: false });
    assert({ given: 'the owner', should: 'allow with a null drive', actual: await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: OWNER, deps: d }), expected: { allowed: true, driveId: null, wakeSubject: { driveId: null, ownerId: OWNER }, sandboxId: 'sbx-ws' } });
  });

  it('an ended session is refused even when its environment is still running', async () => {
    const d = deps({ findSession: async () => session({ envId: 'env1', sandboxId: null, endedAt: NOW }) });
    assert({ given: 'ended env-bound session', should: 'refuse session_ended', actual: await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: USER, deps: d }), expected: { allowed: false, reason: 'session_ended' } });
  });

  it('an env-bound session resolves the ENV sprite (the holder owns the pointer)', async () => {
    const d = deps({ findSession: async () => session({ envId: 'env1', sandboxId: null }) });
    const result = await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'ws1' }, userId: USER, deps: d });
    assert({ given: 'env-bound session', should: 'point at the env sprite', actual: result.allowed && result.sandboxId, expected: 'sbx-env' });
  });

  it('unknown rows refuse: no session, no env, a torn-down sprite resolves to no sandbox', async () => {
    assert({ given: 'no session', should: 'session_not_found', actual: await authorizePreviewHolder({ holder: { kind: 'workspace', id: 'x' }, userId: USER, deps: deps({ findSession: async () => null }) }), expected: { allowed: false, reason: 'session_not_found' } });
    assert({ given: 'no env', should: 'env_not_found', actual: await authorizePreviewHolder({ holder: { kind: 'env', id: 'x' }, userId: USER, deps: deps({ findEnv: async () => null }) }), expected: { allowed: false, reason: 'env_not_found' } });
    const torn = await authorizePreviewHolder({ holder: { kind: 'env', id: 'env1' }, userId: USER, deps: deps({ findEnv: async () => env({ spriteTornDownAt: NOW }) }) });
    assert({ given: 'torn-down env sprite', should: 'allow with no sandbox', actual: torn.allowed && torn.sandboxId, expected: null });
  });

  it('an env: any accepted drive member may view; a local env has nothing to proxy; a vanished drive fails closed', async () => {
    assert({ given: 'member', should: 'allow', actual: await authorizePreviewHolder({ holder: { kind: 'env', id: 'env1' }, userId: USER, deps: deps() }), expected: { allowed: true, driveId: 'd1', wakeSubject: { driveId: 'd1', ownerId: OWNER }, sandboxId: 'sbx-env' } });
    assert({ given: 'non-member', should: 'refuse', actual: await authorizePreviewHolder({ holder: { kind: 'env', id: 'env1' }, userId: USER, deps: deps({ resolveDriveMembership: async () => 'none' }) }), expected: { allowed: false, reason: 'drive_access_denied' } });
    assert({ given: 'local env', should: 'refuse', actual: await authorizePreviewHolder({ holder: { kind: 'env', id: 'env1' }, userId: USER, deps: deps({ findEnv: async () => env({ substrate: 'local', sandboxId: null }) }) }), expected: { allowed: false, reason: 'env_not_sprite' } });
    assert({ given: 'vanished drive', should: 'refuse', actual: await authorizePreviewHolder({ holder: { kind: 'env', id: 'env1' }, userId: USER, deps: deps({ resolveDrivePayer: async () => null }) }), expected: { allowed: false, reason: 'drive_not_found' } });
  });
});

describe('resolvePreviewTarget — the gather, in order', () => {
  const holder = { kind: 'env', id: 'env1' } as const;

  it('forwards a live preview on a running sprite: no wake gate, the upstream is the control-plane URL', async () => {
    const d = deps();
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'live + running', should: 'forward without wake', actual: target.decision, expected: { kind: 'forward', wake: false } });
    assert({ given: 'live + running', should: 'carry the sprite URL', actual: 'spriteUrl' in target ? target.spriteUrl : null, expected: 'https://ps-x-org.sprites.app' });
    assert({ given: 'live + running', should: 'never consult canRunCode', actual: d.calls.includes('canRunCode'), expected: false });
  });

  it('a refused user never causes a control-plane read', async () => {
    const d = deps({ resolveDriveMembership: async () => 'none' });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'denied', should: '404 not-authorized with detail', actual: target.decision, expected: { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: 'drive_access_denied' } });
    assert({ given: 'denied', should: 'never attach, never read the row', actual: d.calls.filter((c) => c === 'attach' || c === 'findRow'), expected: [] });
  });

  it('a dark feature refuses before any read at all', async () => {
    const d = deps({ featureEnabled: () => false });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'dark', should: 'feature-disabled 404', actual: target.decision.kind === 'refuse' && target.decision.reason, expected: 'feature-disabled' });
    assert({ given: 'dark', should: 'not attach', actual: d.calls.includes('attach'), expected: false });
  });

  it('a paused sprite consults the wake gate on the PAYER and forwards as a wake when allowed', async () => {
    let seen: unknown;
    const d = deps({ attach: async () => fakeHandle({ relay: runningRelay(), power: 'paused' }), canRunCode: async (input) => { seen = input; return { ok: true }; } });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'paused + allowed', should: 'forward as a wake', actual: target.decision, expected: { kind: 'forward', wake: true } });
    assert({ given: 'paused', should: 'ask canRunCode for the payer, not the viewer', actual: seen, expected: { userId: USER, driveId: 'd1', ownerId: OWNER } });
  });

  it('a paused sprite with a denied wake gate is refused 403 and NOT forwarded', async () => {
    const d = deps({ attach: async () => fakeHandle({ relay: runningRelay(), power: 'paused' }), canRunCode: async () => ({ ok: false, reason: 'tier_ineligible' }) });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'paused + denied', should: 'wake-denied', actual: target.decision, expected: { kind: 'refuse', reason: 'wake-denied', status: 403, message: 'This sandbox is asleep, and you are not permitted to wake it.', detail: 'tier_ineligible' } });
    expect('spriteUrl' in target).toBe(false);
  });

  it('a stale row (dead instance) is refused, never routed, and never wakes', async () => {
    const d = deps({ attach: async () => fakeHandle({ relay: runningRelay(), power: 'paused', instance: 'inst-2' }) });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'row for inst-1, live inst-2', should: 'stale-instance 409', actual: target.decision.kind === 'refuse' && [target.decision.reason, target.decision.status], expected: ['stale-instance', 409] });
    assert({ given: 'stale', should: 'never consult the wake gate', actual: d.calls.includes('canRunCode'), expected: false });
  });

  it('no row, no sprite, or a vanished sprite is no-preview', async () => {
    assert({ given: 'no row', should: 'no-preview', actual: (await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ previewStore: { findByHolder: async () => null, upsert: async () => true, setStoppedByUser: async () => null } }) })).decision.kind === 'refuse' && 'no-preview', expected: 'no-preview' });
    const noSprite = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ findEnv: async () => env({ sandboxId: null }) }) });
    assert({ given: 'no sprite pointer', should: 'no-preview without attaching', actual: noSprite.decision.kind === 'refuse' && noSprite.decision.reason, expected: 'no-preview' });
    const vanished = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ attach: async () => null }) });
    assert({ given: 'attach returned null', should: 'no-preview', actual: vanished.decision.kind === 'refuse' && vanished.decision.reason, expected: 'no-preview' });
  });

  it('refuses to forward to a sprite whose URL is missing or not in private mode', async () => {
    const noUrl = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ attach: async () => fakeHandle({ relay: runningRelay(), url: null }) }) });
    assert({ given: 'no url', should: '502', actual: noUrl.decision.kind === 'refuse' && noUrl.decision.status, expected: 502 });
    const pub = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ attach: async () => fakeHandle({ relay: runningRelay(), auth: 'public' }) }) });
    assert({ given: 'public url', should: 'refuse rather than proxy an unproven-private URL', actual: pub.decision.kind, expected: 'refuse' });
  });

  it('a down relay is refused 502 (state folded with listeners: null — never a probe)', async () => {
    const d = deps({ attach: async () => fakeHandle({ relay: { ...runningRelay(), status: 'failed', error: 'exited with code 143' } }) });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'failed relay', should: 'preview-down 502', actual: target.decision.kind === 'refuse' && [target.decision.reason, target.decision.status], expected: ['preview-down', 502] });
  });
});

/**
 * t09: a LOCAL environment has no dev-preview surface at all — `urlInfo`,
 * `powerState` and `services.*` all refuse with a typed error. Three of the
 * four calls in this function's gather would reject, so without the
 * capability check the whole flow faults on whichever lost the race.
 */
describe('resolvePreviewTarget — a substrate with no preview surface', () => {
  const holder = { kind: 'env', id: 'env1' } as const;
  const noPreview: SandboxCapabilities = { ...SPRITE_SANDBOX_CAPABILITIES, preview: false, services: false };

  const localHandle = (): SandboxHandle => {
    const refuse = () => Promise.reject(new LocalEnvUnsupportedError('urlInfo', 'env1'));
    return {
      ...fakeHandle({ capabilities: noPreview }),
      urlInfo: refuse,
      powerState: refuse,
      services: { create: refuse, list: refuse, get: refuse, start: refuse, stop: refuse, remove: refuse },
    } as SandboxHandle;
  };

  it('should refuse with a typed preview-unsupported reason rather than faulting on the refusing members', async () => {
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ attach: async () => localHandle() }) });

    expect(target.decision).toMatchObject({ kind: 'refuse', reason: 'preview-unsupported', status: 409 });
  });

  it('should never TOUCH the refusing members — the advertised capability answers first', async () => {
    let touched = 0;
    const handle = { ...localHandle(), powerState: async () => { touched += 1; return 'running' as const; } } as SandboxHandle;

    await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps({ attach: async () => handle }) });

    expect(touched).toBe(0);
  });

  it('CONTROL: the same request against a Sprite handle still forwards — proving the refusal above is load-bearing', async () => {
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: deps() });
    expect(target.decision.kind).toBe('forward');
  });
});


describe('resolvePreviewTarget — the cookie is only as alive as its session', () => {
  const holder = { kind: 'env', id: 'env1' } as const;

  it('a revoked session is refused on the VERY NEXT request, before any holder read, attach or wake gate', async () => {
    // The ordering is the security property: a refusal here must cost no
    // control-plane call, exactly as an authorization refusal does.
    const before = deps();
    assert({ given: 'a usable session', should: 'forward', actual: (await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: before })).decision.kind, expected: 'forward' });

    const after = deps({ isSessionUsable: async () => false });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: after });
    assert({ given: 'the same cookie after the session is revoked', should: 'opaque 404 with a session_revoked detail', actual: target.decision, expected: { kind: 'refuse', reason: 'not-authorized', status: 404, message: 'Not found', detail: 'session_revoked' } });
    assert({ given: 'a revoked session', should: 'read no holder row, never attach, never ask the wake gate', actual: after.calls.filter((c) => c === 'findEnv' || c === 'findSession' || c === 'attach' || c === 'canRunCode' || c === 'findRow'), expected: [] });
  });

  it('is asked for the cookie\'s own session and user — not the holder owner', async () => {
    let seen: unknown;
    const d = deps({ isSessionUsable: async (input) => { seen = input; return true; } });
    await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'a request', should: 'name the cookie session and the cookie user', actual: seen, expected: { sessionId: SESSION, userId: USER } });
  });

  it('a dark deployment reveals nothing and does not even ask about the session', async () => {
    const d = deps({ featureEnabled: () => false, isSessionUsable: async () => false });
    const target = await resolvePreviewTarget({ holder, userId: USER, sessionId: SESSION, deps: d });
    assert({ given: 'dark', should: 'still answer feature-disabled', actual: target.decision.kind === 'refuse' && target.decision.reason, expected: 'feature-disabled' });
    assert({ given: 'dark', should: 'cost no session query', actual: d.calls.includes('isSessionUsable'), expected: false });
  });
});
