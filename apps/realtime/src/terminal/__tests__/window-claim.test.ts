/**
 * claimBillingWindow under its lock, and the lock module itself (re-review #2760 P2-1, 5408117045).
 * The real-Postgres races live in shell-payer-drift.integration.test.ts; these pin every exit of
 * the claim and of both lock implementations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRealtimeLogger, mockWithBlocking } = vi.hoisted(() => ({
  mockRealtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockWithBlocking: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { realtime: mockRealtimeLogger } }));
vi.mock('@pagespace/db/db', () => ({ getAdvisoryLockPool: () => ({ connect: vi.fn() }) }));
vi.mock('@pagespace/db/advisory-lock', () => ({ withBlockingAdvisoryLock: mockWithBlocking }));

import { claimBillingWindow } from '../shell-handler';
import { inProcessWindowClaimLock, pgWindowClaimLock, windowClaimLockKey, WINDOW_CLAIM_LOCK_TIMEOUT_MS, type WindowClaimLock } from '../window-claim-lock';
import type { TerminalSession, TerminalSessionMap } from '../terminal-session-map';
import type { SandboxBillingDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { ORG_COMPUTE_REFUSAL_MESSAGES } from '@pagespace/lib/billing/compute-charge';

const ORG = { kind: 'org' as const, orgId: 'org-1' };

function makeSession(over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    sessionKey: 'k1',
    charge: { ...ORG, userId: 'priya' },
    ownerId: 'priya',
    actorId: 'priya',
    holdId: 'hold-priya',
    connectedAt: Date.now() - 60_000,
    driveId: 'drive-1',
    workspaceId: 'ws-1',
    ...over,
  } as unknown as TerminalSession;
}

function mapOf(session: TerminalSession | undefined): TerminalSessionMap {
  return { getByKey: (key: string) => (session && key === session.sessionKey ? session : undefined) } as unknown as TerminalSessionMap;
}

function makeBilling(over: Partial<Record<keyof SandboxBillingDeps, ReturnType<typeof vi.fn>>> = {}) {
  return {
    resolveCharge: vi.fn(async ({ actorId }: { actorId: string }) => ({ ...ORG, userId: actorId })),
    gate: vi.fn(async () => ({ allowed: true, holdId: 'hold-ben' })),
    trackUsage: vi.fn(async () => ({ persisted: true, creditsSettled: true })),
    releaseHold: vi.fn(async () => {}),
    ...over,
  } as unknown as SandboxBillingDeps & Record<'resolveCharge' | 'gate' | 'trackUsage' | 'releaseHold', ReturnType<typeof vi.fn>>;
}

/** A lock that runs `before` (what another claim did while this one waited), then the claim. */
const lockAfter = (before: () => void): WindowClaimLock => async (_key, fn) => {
  before();
  return { acquired: true, result: await fn() };
};

beforeEach(() => vi.clearAllMocks());

describe('claimBillingWindow — every exit, under the lock', () => {
  it('is inert, and takes no lock, for an unmetered session, an ownerless one, or the window\'s own actor', async () => {
    const lock = vi.fn() as unknown as WindowClaimLock;
    const billing = makeBilling();
    for (const session of [makeSession({ charge: undefined }), makeSession({ ownerId: undefined }), makeSession({ actorId: 'ben' })]) {
      expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', lock)).toEqual({ ok: true });
    }
    expect(lock).not.toHaveBeenCalled();
    expect(billing.gate).not.toHaveBeenCalled();
  });

  it('WAL-2 (partial) a lock it could not take refuses with the retry message, and nothing is gated', async () => {
    const billing = makeBilling();
    const session = makeSession();
    const busy: WindowClaimLock = async () => ({ acquired: false });
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', busy)).toEqual({ ok: false, message: expect.stringMatching(/briefly busy/) });
    expect(billing.gate).not.toHaveBeenCalled();
  });

  it('a lock that throws refuses with the retry message and logs', async () => {
    const session = makeSession();
    const broken: WindowClaimLock = async () => {
      throw new Error('pool gone');
    };
    expect(await claimBillingWindow(makeBilling(), mapOf(session), session, 'ben', broken)).toEqual({ ok: false, message: expect.stringMatching(/briefly busy/) });
    expect(mockRealtimeLogger.error).toHaveBeenCalled();
  });

  it('re-checks under the lock: a session that ended while it waited is refused, untouched', async () => {
    const billing = makeBilling();
    const session = makeSession();
    let live: TerminalSession | undefined = session;
    const map = { getByKey: () => live } as unknown as TerminalSessionMap;
    expect(await claimBillingWindow(billing, map, session, 'ben', lockAfter(() => { live = undefined; }))).toEqual({ ok: false });
    expect(billing.gate).not.toHaveBeenCalled();
  });

  it('re-checks under the lock: a window that moved to this very typist meanwhile (their other connection) claims nothing more', async () => {
    const billing = makeBilling();
    const session = makeSession();
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', lockAfter(() => { session.actorId = 'ben'; }))).toEqual({ ok: true });
    expect(billing.gate).not.toHaveBeenCalled();
  });

  it('a billing READ failure refuses: an unanswerable cap is not a pass', async () => {
    const session = makeSession();
    const billing = makeBilling({ resolveCharge: vi.fn().mockRejectedValue(new Error('db down')) });
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
    expect(session.actorId).toBe('priya');
  });

  it('a gate refusal carries the org message only for an org refusal it knows', async () => {
    const session = makeSession();
    const capped = makeBilling({ gate: vi.fn(async () => ({ allowed: false, reason: 'org_member_cap_reached', orgRefusal: 'org_member_cap_reached' })) });
    expect(await claimBillingWindow(capped, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false, message: ORG_COMPUTE_REFUSAL_MESSAGES.org_member_cap_reached });
    const personal = makeBilling({ gate: vi.fn(async () => ({ allowed: false, reason: 'out_of_credits' })) });
    expect(await claimBillingWindow(personal, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
    const unknown = makeBilling({ gate: vi.fn(async () => ({ allowed: false, orgRefusal: 'something_new' })) });
    expect(await claimBillingWindow(unknown, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
  });

  it('a session that ended during the settle releases the typist\'s hold and refuses', async () => {
    const session = makeSession();
    let live: TerminalSession | undefined = session;
    const map = { getByKey: () => live } as unknown as TerminalSessionMap;
    const billing = makeBilling({
      trackUsage: vi.fn(async () => {
        live = undefined;
        return { persisted: true, creditsSettled: true };
      }),
    });
    // The settle sees the session gone and stops; the typist's input is refused (retry), their hold released.
    expect(await claimBillingWindow(billing, map, session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false, message: expect.stringMatching(/briefly busy/) });
    expect(billing.releaseHold).toHaveBeenCalledWith('hold-ben');
    expect(session.actorId).toBe('priya');
  });

  it('a session that ended right AFTER the settle releases the typist\'s hold and refuses, without taking the window', async () => {
    const session = makeSession();
    let reads = 0;
    // Live for the claim's own check and the settle's, gone by the time the window would move.
    const map = { getByKey: () => (++reads <= 2 ? session : undefined) } as unknown as TerminalSessionMap;
    const billing = makeBilling();
    expect(await claimBillingWindow(billing, map, session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
    expect(billing.releaseHold).toHaveBeenCalledWith('hold-ben');
    expect(session.actorId).toBe('priya');
  });

  it('a quiesced window (no clock running) moves to the typist without a settle', async () => {
    const session = makeSession({ connectedAt: undefined });
    const billing = makeBilling();
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: true });
    expect(billing.trackUsage).not.toHaveBeenCalled();
    expect([session.actorId, session.holdId, session.charge]).toEqual(['ben', 'hold-ben', { ...ORG, userId: 'ben' }]);
  });

  it('non-Error failures (a thrown string from the lock or the payer read) still refuse and log', async () => {
    const session = makeSession();
    const throwsString: WindowClaimLock = async () => {
      throw 'lock exploded';
    };
    expect(await claimBillingWindow(makeBilling(), mapOf(session), session, 'ben', throwsString)).toMatchObject({ ok: false });
    const billing = makeBilling({ resolveCharge: vi.fn().mockRejectedValue('db exploded') });
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
    expect(mockRealtimeLogger.error).toHaveBeenCalledTimes(2);
  });

  it('a session with no drive resolves the typist\'s charge with a null drive, and a payer that drifted during the settle is re-read', async () => {
    const session = makeSession({ driveId: undefined });
    const billing = makeBilling({
      // The settle's re-read finds the opener's drive moved to a personal payer; the typist's own charge is still resolved.
      resolveCharge: vi.fn(async ({ actorId }: { actorId: string }) => (actorId === 'priya' ? { kind: 'user' as const, userId: 'priya' } : { ...ORG, userId: actorId })),
    });
    expect(await claimBillingWindow(billing, mapOf(session), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: true });
    expect(billing.resolveCharge).toHaveBeenCalledWith({ driveId: null, ownerId: 'priya', actorId: 'ben' });
    expect(mockRealtimeLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/payer changed/), expect.anything());
    expect(session.charge).toEqual({ ...ORG, userId: 'ben' });
  });

  it('a claim against a map that no longer holds the session is refused', async () => {
    const session = makeSession();
    expect(await claimBillingWindow(makeBilling(), mapOf(undefined), session, 'ben', inProcessWindowClaimLock)).toEqual({ ok: false });
  });

  it('the default lock is the in-process chain', async () => {
    const session = makeSession();
    expect(await claimBillingWindow(makeBilling(), mapOf(session), session, 'ben')).toEqual({ ok: true });
    expect(session.actorId).toBe('ben');
  });
});

describe('the window-claim locks', () => {
  it('pgWindowClaimLock waits on the session\'s key for the bounded time and hands back fn\'s result', async () => {
    mockWithBlocking.mockImplementationOnce(async (_pool, _key, fn: () => Promise<string>) => ({ outcome: 'acquired', result: await fn() }));
    expect(await pgWindowClaimLock('k1', async () => 'claimed')).toEqual({ acquired: true, result: 'claimed' });
    expect(mockWithBlocking).toHaveBeenCalledWith(expect.anything(), windowClaimLockKey('k1'), expect.any(Function), { timeoutMs: WINDOW_CLAIM_LOCK_TIMEOUT_MS });
  });

  it('pgWindowClaimLock reports a busy lock as not acquired, and a connection error too — logged, never run unlocked', async () => {
    const fn = vi.fn(async () => 'unreachable');
    mockWithBlocking.mockResolvedValueOnce({ outcome: 'lock_busy' });
    expect(await pgWindowClaimLock('k1', fn)).toEqual({ acquired: false });
    expect(mockRealtimeLogger.warn).not.toHaveBeenCalled();
    mockWithBlocking.mockResolvedValueOnce({ outcome: 'connection_error', error: new Error('reset') });
    expect(await pgWindowClaimLock('k1', fn)).toEqual({ acquired: false });
    expect(mockRealtimeLogger.warn).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('the in-process lock runs one session\'s claims one after another, and a failed claim does not wedge the next', async () => {
    const order: string[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = inProcessWindowClaimLock('k-chain', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      throw new Error('first failed');
    });
    const second = inProcessWindowClaimLock('k-chain', async () => {
      order.push('second');
      return 'second';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toEqual({ acquired: true, result: 'second' });
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
